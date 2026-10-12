import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Usuario } from '../usuarios/entities/usuario.entity';
import { PagoHistorial } from './entities/pago-historial.entity';
import { Suscripcion } from './entities/suscripcion.entity';
import { esEstadoBloqueado, MENSAJE_SUSCRIPCION_REQUERIDA } from './bloqueo';
import { estadoEfectivo } from './estado-efectivo';
import { aIsoNegocio, finDePrueba } from './fechas';
import type {
  PagoHistorialResponse,
  SuscripcionSnapshot,
} from './interfaces/suscripcion-response.interface';

/** Máximo de pagos que devuelve `historial` en el snapshot (los más recientes). */
export const MAX_HISTORIAL = 24;

@Injectable()
export class SuscripcionesService {
  constructor(
    @InjectRepository(Suscripcion)
    private readonly suscripcionRepository: Repository<Suscripcion>,
    @InjectRepository(PagoHistorial)
    private readonly pagoHistorialRepository: Repository<PagoHistorial>,
  ) {}

  /**
   * Crea la prueba de 14 días de una cuenta. Idempotente: si ya existe una
   * fila para `usuarioId` no hace nada (`ON CONFLICT ("usuario_id") DO
   * NOTHING`, sobre el UNIQUE `UQ_suscripciones_usuario_id`). Con `manager`
   * participa en la transacción del llamador (ej. el registro).
   */
  async crearPrueba(
    usuarioId: string,
    inicio: Date = new Date(),
    manager?: EntityManager,
  ): Promise<void> {
    const executor = manager ?? this.suscripcionRepository.manager;
    await executor.query(
      `INSERT INTO "suscripciones"
         ("usuario_id", "estado", "prueba_inicio", "prueba_fin", "estado_desde")
       VALUES ($1, 'prueba', $2, $3, $2)
       ON CONFLICT ("usuario_id") DO NOTHING`,
      [usuarioId, inicio, finDePrueba(inicio)],
    );
  }

  /**
   * Snapshot de la suscripción de la cuenta (contrato de
   * flujo_suscripcion.md, sección 2.1; reglas de la 3.7). Si la cuenta no
   * tiene fila (carrera con el registro o error al crearla), la repara con
   * `crearPrueba(usuario.id, usuario.createdAt)` y vuelve a leer.
   * `historial` trae los últimos `MAX_HISTORIAL` pagos de la cuenta (más
   * reciente primero). Nunca envía `gracia` ni `gracia_fin`.
   */
  async snapshot(
    usuario: Pick<Usuario, 'id' | 'createdAt'>,
    ahora: Date = new Date(),
  ): Promise<SuscripcionSnapshot> {
    const fila = await this.obtenerFila(usuario);

    const efectivo = estadoEfectivo(fila, ahora);
    const esActiva = efectivo.estado === 'activa';
    const conMotivo =
      efectivo.estado === 'prueba_vencida' || efectivo.estado === 'vencida';

    return {
      estado: efectivo.estado,
      prueba_inicio: aIsoNegocio(fila.pruebaInicio),
      prueba_fin: aIsoNegocio(fila.pruebaFin),
      acceso_hasta: fila.accesoHasta ? aIsoNegocio(fila.accesoHasta) : null,
      proximo_cobro:
        esActiva && fila.renovacionAutomatica && fila.proximoCobro
          ? aIsoNegocio(fila.proximoCobro)
          : null,
      renovacion_automatica: esActiva ? fila.renovacionAutomatica : false,
      tienda: fila.tienda,
      motivo: conMotivo ? efectivo.motivo : null,
      ahora_servidor: aIsoNegocio(ahora),
      historial: await this.historial(usuario.id),
    };
  }

  /**
   * `true` si el estado efectivo de la cuenta bloquea las escrituras
   * (`prueba_vencida`, `vencida`, `pago_en_proceso`). Una sola consulta (por el
   * UNIQUE de `usuario_id`), sin cargar el historial. `ahora` es siempre la
   * hora del servidor; nunca la del teléfono ni una ventana de tolerancia.
   */
  async estaBloqueada(
    usuario: Pick<Usuario, 'id' | 'createdAt'>,
    ahora: Date = new Date(),
  ): Promise<boolean> {
    const fila = await this.obtenerFila(usuario);
    return esEstadoBloqueado(estadoEfectivo(fila, ahora).estado);
  }

  /** Lanza 403 `SUSCRIPCION_REQUERIDA` si la cuenta está bloqueada. */
  async assertPuedeEscribir(
    usuario: Pick<Usuario, 'id' | 'createdAt'>,
    ahora: Date = new Date(),
  ): Promise<void> {
    if (await this.estaBloqueada(usuario, ahora)) {
      throw new ForbiddenException(MENSAJE_SUSCRIPCION_REQUERIDA);
    }
  }

  /**
   * Fila de la cuenta; si no existe (carrera con el registro o error al
   * crearla) la repara con `crearPrueba(usuario.id, usuario.createdAt)` y
   * vuelve a leer.
   */
  async obtenerFila(
    usuario: Pick<Usuario, 'id' | 'createdAt'>,
  ): Promise<Suscripcion> {
    let fila = await this.buscarPorUsuario(usuario.id);
    if (!fila) {
      await this.crearPrueba(usuario.id, usuario.createdAt);
      fila = await this.buscarPorUsuario(usuario.id);
    }
    if (!fila) {
      throw new Error(
        `No se pudo obtener ni crear la suscripción del usuario ${usuario.id}`,
      );
    }
    return fila;
  }

  /**
   * Últimos `MAX_HISTORIAL` pagos de la cuenta, `cobrado_en` descendente y
   * `created_at` descendente como desempate (cubierto por
   * IDX_pagos_historial_usuario_cobrado).
   */
  private async historial(usuarioId: string): Promise<PagoHistorialResponse[]> {
    const pagos = await this.pagoHistorialRepository.find({
      where: { usuarioId },
      order: { cobradoEn: 'DESC', createdAt: 'DESC' },
      take: MAX_HISTORIAL,
    });
    return pagos.map((pago) => ({
      id: pago.externalId,
      periodo: pago.periodo,
      cobrado_en: aIsoNegocio(pago.cobradoEn),
      monto: pago.monto,
      moneda: pago.moneda.trim(),
      estado: pago.estado,
    }));
  }

  private buscarPorUsuario(usuarioId: string): Promise<Suscripcion | null> {
    return this.suscripcionRepository.findOne({ where: { usuarioId } });
  }
}
