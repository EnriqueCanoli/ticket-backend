import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { Usuario } from '../usuarios/entities/usuario.entity';
import { CONFIG_SUSCRIPCION } from './config-suscripcion';
import type { ConfigSuscripcion } from './config-suscripcion';
import { CuentaOfuscadaService } from './cuenta-ofuscada';
import type { RestaurarComprasDto } from './dto/restaurar-compras.dto';
import type { ValidarCompraDto } from './dto/validar-compra.dto';
import { Compra } from './entities/compra.entity';
import { Suscripcion } from './entities/suscripcion.entity';
import { estadoEfectivo } from './estado-efectivo';
import { periodoNegocio } from './fechas';
import type {
  SuscripcionSnapshot,
  TiendaSuscripcion,
} from './interfaces/suscripcion-response.interface';
import { SuscripcionesService } from './suscripciones.service';
import { VERIFICADOR_TIENDA } from './verificadores/verificador-tienda.interface';
import type { VerificadorTienda } from './verificadores/verificador-tienda.interface';

export const MENSAJE_TIENDA_EN_USO =
  'TIENDA_EN_USO: esta cuenta de Google Play ya está en uso por otra cuenta';
export const MENSAJE_PRODUCTO_INVALIDO =
  'PRODUCTO_INVALIDO: el producto no corresponde a la suscripción';
export const MENSAJE_COMPRA_RECHAZADA =
  'COMPRA_RECHAZADA: la tienda no confirmó la compra';

/** SQLSTATE de Postgres para `unique_violation`. */
const POSTGRES_UNIQUE_VIOLATION = '23505';

type UsuarioSuscripcion = Pick<Usuario, 'id' | 'createdAt'>;

export type ResultadoCompra =
  'aplicada' | 'ya_era_propia' | 'ignorada_mes_vigente';

/**
 * Compra de la suscripción (etapa 4a): `validar-compra` y `restaurar`. Es un
 * servicio aparte de `SuscripcionesService` para no cambiar el constructor de
 * este (sus specs lo construyen con `new SuscripcionesService(repo,
 * pagoRepo)`). La tienda se consulta a través de `VerificadorTienda`.
 */
@Injectable()
export class CompraSuscripcionService {
  private readonly logger = new Logger(CompraSuscripcionService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Compra)
    private readonly compraRepository: Repository<Compra>,
    private readonly suscripcionesService: SuscripcionesService,
    @Inject(VERIFICADOR_TIENDA)
    private readonly verificador: VerificadorTienda,
    @Inject(CONFIG_SUSCRIPCION)
    private readonly config: ConfigSuscripcion,
    private readonly cuentaOfuscada: CuentaOfuscadaService,
  ) {}

  async validarCompra(
    usuario: UsuarioSuscripcion,
    dto: ValidarCompraDto,
  ): Promise<SuscripcionSnapshot> {
    await this.procesarCompra(
      usuario,
      dto.tienda,
      dto.producto_id,
      dto.token_compra,
    );
    return this.suscripcionesService.snapshot(usuario);
  }

  /**
   * Aplica cada compra propia del arreglo (D9). Las inválidas (400) se
   * ignoran; si ninguna resultó propia y hubo al menos una ajena (409), 409.
   * En cualquier otro caso, 200 con el snapshot final.
   */
  async restaurarCompras(
    usuario: UsuarioSuscripcion,
    dto: RestaurarComprasDto,
  ): Promise<SuscripcionSnapshot> {
    const vistos = new Set<string>();
    let hayConflicto = false;
    let hayExito = false;

    for (const compra of dto.compras) {
      if (vistos.has(compra.token_compra)) continue;
      vistos.add(compra.token_compra);
      try {
        await this.procesarCompra(
          usuario,
          dto.tienda,
          compra.producto_id,
          compra.token_compra,
        );
        hayExito = true;
      } catch (error) {
        if (error instanceof BadRequestException) continue;
        if (error instanceof ConflictException) {
          hayConflicto = true;
          continue;
        }
        throw error;
      }
    }

    if (!hayExito && hayConflicto) {
      throw new ConflictException(MENSAJE_TIENDA_EN_USO);
    }
    return this.suscripcionesService.snapshot(usuario);
  }

  /**
   * Etapa 5 (F5): compra que llega por aviso RTDN sin haber pasado por la app.
   * Aplica EXACTAMENTE las reglas de `validar-compra` (D1, D2, E8, E12, carrera
   * por el UNIQUE y acknowledge en el servidor). Lanza BadRequest / Conflict
   * como `validarCompra`; el llamador los traduce a un resultado del evento.
   */
  aplicarCompraDeTienda(
    usuario: UsuarioSuscripcion,
    productoId: string,
    token: string,
    ahora: Date = new Date(),
  ): Promise<ResultadoCompra> {
    return this.procesarCompra(
      usuario,
      'google_play',
      productoId,
      token,
      ahora,
    );
  }

  private async procesarCompra(
    usuario: UsuarioSuscripcion,
    tienda: TiendaSuscripcion,
    productoId: string,
    token: string,
    ahora: Date = new Date(),
  ): Promise<ResultadoCompra> {
    if (productoId !== this.config.productoSuscripcionId) {
      throw new BadRequestException(MENSAJE_PRODUCTO_INVALIDO);
    }
    await this.suscripcionesService.obtenerFila(usuario);

    const existente = await this.compraRepository.findOne({
      where: { tienda, purchaseToken: token },
    });
    if (existente) {
      if (existente.usuarioId !== usuario.id) {
        throw new ConflictException(MENSAJE_TIENDA_EN_USO);
      }
      if (existente.estado !== 'pendiente') {
        await this.reconocerSiHaceFalta(existente);
        return 'ya_era_propia';
      }
      // Propia y pendiente: se vuelve a verificar (D8).
    }

    // La consulta a la tienda va FUERA de la transacción (no retiene el lock).
    // Un TIENDA_NO_DISPONIBLE (503) sale de aquí sin tocar la BD.
    const resultado = await this.verificador.verificar({
      productoId,
      tokenCompra: token,
      usuarioId: usuario.id,
    });
    if (resultado.estado === 'rechazada') {
      if (existente) {
        // E12: una compra propia pendiente que la tienda cancela deja de
        // estar pendiente y, si era lo que mantenía la cuenta en
        // pago_en_proceso, la saca de ahí.
        await this.expirarPendiente(usuario, existente, ahora);
      }
      throw new BadRequestException(MENSAJE_COMPRA_RECHAZADA);
    }
    if (
      resultado.cuentaOfuscada !== null &&
      resultado.cuentaOfuscada !== this.cuentaOfuscada.calcular(usuario.id)
    ) {
      // La compra se hizo con la `cuenta_ofuscada` de otra cuenta de la app
      // (HMAC del id de usuario). Sin identificador (null) se acepta y se
      // liga a quien la envía (E8).
      throw new ConflictException(MENSAJE_TIENDA_EN_USO);
    }
    if (
      resultado.estado === 'activa' &&
      (resultado.orderId === null ||
        resultado.periodoInicio === null ||
        resultado.periodoFin === null)
    ) {
      throw new BadRequestException(MENSAJE_COMPRA_RECHAZADA);
    }

    let salida: { resultado: ResultadoCompra; compraId: string | null };
    try {
      salida = await this.dataSource.transaction(async (manager) => {
        const suscripcionRepo = manager.getRepository(Suscripcion);
        const compraRepo = manager.getRepository(Compra);

        const fila = await suscripcionRepo.findOne({
          where: { usuarioId: usuario.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!fila) {
          throw new Error(
            `La suscripción del usuario ${usuario.id} desapareció durante la compra`,
          );
        }

        const actual = await compraRepo.findOne({
          where: { tienda, purchaseToken: token },
        });
        if (actual) {
          if (actual.usuarioId !== usuario.id) {
            throw new ConflictException(MENSAJE_TIENDA_EN_USO);
          }
          if (actual.estado !== 'pendiente') {
            return { resultado: 'ya_era_propia', compraId: null };
          }
        }

        const efectivo = estadoEfectivo(fila, ahora);
        const mesPagadoVigente =
          efectivo.estado === 'activa' || efectivo.estado === 'cancelada';

        const guardarCompra = async (
          estado: 'confirmada' | 'pendiente',
        ): Promise<Compra> => {
          const compra =
            actual ??
            compraRepo.create({
              usuarioId: usuario.id,
              suscripcionId: fila.id,
              tienda,
              purchaseToken: token,
              reconocidaEn: null,
            });
          compra.productoId = productoId;
          compra.orderId = resultado.orderId;
          compra.estado = estado;
          compra.periodoInicio = resultado.periodoInicio;
          compra.periodoFin = resultado.periodoFin;
          if (estado === 'confirmada' && resultado.yaReconocida) {
            // La tienda ya la reconoció: no hace falta llamar a `reconocer`.
            compra.reconocidaEn = compra.reconocidaEn ?? ahora;
          }
          return compraRepo.save(compra);
        };

        if (resultado.estado === 'activa') {
          if (!actual && mesPagadoVigente) {
            // D2: ya hay un mes pagado vigente; no se cobra otro y no se
            // registra el token (nunca se imprime).
            this.logger.warn(
              `Compra nueva ignorada: el usuario ${usuario.id} ya tiene un mes pagado vigente (orderId ${resultado.orderId}). No se reconoce: la tienda la reembolsará.`,
            );
            return { resultado: 'ignorada_mes_vigente', compraId: null };
          }

          const periodoInicio = resultado.periodoInicio as Date;
          const periodoFin = resultado.periodoFin as Date;
          const compra = await guardarCompra('confirmada');
          if (resultado.monto === null || resultado.moneda === null) {
            // El CHECK de `pagos_historial` exige monto >= 0 y moneda: sin
            // dato de la tienda se inserta 0 (y la moneda por defecto).
            this.logger.warn(
              `Pago del usuario ${usuario.id} sin monto o moneda de la tienda (orderId ${resultado.orderId}): se registra 0`,
            );
          }
          await manager.query(
            `INSERT INTO "pagos_historial"
               ("usuario_id", "compra_id", "tienda", "external_id", "periodo",
                "cobrado_en", "monto", "moneda", "estado")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pagado')
             ON CONFLICT ("tienda", "external_id") DO NOTHING`,
            [
              usuario.id,
              compra.id,
              tienda,
              resultado.orderId,
              periodoNegocio(periodoInicio),
              periodoInicio,
              resultado.monto ?? 0,
              resultado.moneda ?? 'MXN',
            ],
          );
          await suscripcionRepo.update(
            { id: fila.id },
            {
              estado: 'activa',
              accesoHasta: periodoFin,
              proximoCobro: resultado.autoRenovacion ? periodoFin : null,
              renovacionAutomatica: resultado.autoRenovacion,
              tienda: 'google_play',
              motivo: null,
              ...(fila.estado !== 'activa' ? { estadoDesde: ahora } : {}),
            },
          );
          return { resultado: 'aplicada', compraId: compra.id };
        }

        // Pendiente (p. ej. OXXO).
        await guardarCompra('pendiente');
        if (efectivo.estado !== 'prueba' && !mesPagadoVigente) {
          // D1: sin días restantes → pago_en_proceso (bloquea).
          await suscripcionRepo.update(
            { id: fila.id },
            {
              estado: 'pago_en_proceso',
              tienda: 'google_play',
              renovacionAutomatica: false,
              proximoCobro: null,
              motivo: null,
              ...(fila.estado !== 'pago_en_proceso'
                ? { estadoDesde: ahora }
                : {}),
            },
          );
        }
        return { resultado: 'aplicada', compraId: null };
      });
    } catch (error) {
      if (!this.esViolacionUnica(error)) throw error;
      // Carrera por el UNIQUE (tienda, purchase_token): se relee fuera.
      const ganadora = await this.compraRepository.findOne({
        where: { tienda, purchaseToken: token },
      });
      if (!ganadora) throw error;
      if (ganadora.usuarioId !== usuario.id) {
        throw new ConflictException(MENSAJE_TIENDA_EN_USO);
      }
      return 'ya_era_propia';
    }

    if (salida.compraId !== null) {
      const compra = await this.compraRepository.findOne({
        where: { id: salida.compraId },
      });
      if (compra) await this.reconocerSiHaceFalta(compra);
    }
    return salida.resultado;
  }

  /**
   * E12: pasa a `expirada` una compra propia pendiente que la tienda ya no
   * da por válida. Si la suscripción está en `pago_en_proceso` y no queda
   * otra compra pendiente, la devuelve a `prueba_vencida` (nunca pagó) o a
   * `vencida` (ya había pagado).
   */
  private async expirarPendiente(
    usuario: UsuarioSuscripcion,
    existente: Compra,
    ahora: Date,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const suscripcionRepo = manager.getRepository(Suscripcion);
      const compraRepo = manager.getRepository(Compra);

      const fila = await suscripcionRepo.findOne({
        where: { usuarioId: usuario.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!fila) return;

      const actual = await compraRepo.findOne({ where: { id: existente.id } });
      if (!actual || actual.estado !== 'pendiente') return;
      await compraRepo.update({ id: actual.id }, { estado: 'expirada' });

      if (fila.estado !== 'pago_en_proceso') return;
      const otras = await compraRepo.count({
        where: { usuarioId: usuario.id, estado: 'pendiente' },
      });
      if (otras > 0) return;

      const nuncaPago = fila.accesoHasta === null;
      await suscripcionRepo.update(
        { id: fila.id },
        {
          estado: nuncaPago ? 'prueba_vencida' : 'vencida',
          motivo: nuncaPago ? 'prueba_terminada' : 'cancelada',
          estadoDesde: ahora,
        },
      );
    });
  }

  /**
   * Acknowledge de una compra `confirmada` sin `reconocida_en`. Un fallo se
   * registra y NO rompe la activación (se reintenta al reenviar el token).
   */
  async reconocerSiHaceFalta(compra: Compra): Promise<void> {
    if (compra.estado !== 'confirmada' || compra.reconocidaEn) return;
    try {
      await this.verificador.reconocer({
        productoId: compra.productoId,
        tokenCompra: compra.purchaseToken,
      });
      await this.compraRepository.update(
        { id: compra.id },
        { reconocidaEn: new Date() },
      );
    } catch (error) {
      this.logger.error(
        `No se pudo reconocer la compra ${compra.id} (usuario ${compra.usuarioId})`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private esViolacionUnica(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    const driver = error.driverError as { code?: string } | undefined;
    return driver?.code === POSTGRES_UNIQUE_VIOLATION;
  }
}
