import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  MoreThan,
  Not,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { Usuario } from '../../usuarios/entities/usuario.entity';
import { CompraSuscripcionService } from '../compra-suscripcion.service';
import { CONFIG_SUSCRIPCION } from '../config-suscripcion';
import type { ConfigSuscripcion } from '../config-suscripcion';
import { CuentaOfuscadaService } from '../cuenta-ofuscada';
import { Compra } from '../entities/compra.entity';
import { EventoTienda } from '../entities/evento-tienda.entity';
import { PagoHistorial } from '../entities/pago-historial.entity';
import { Suscripcion } from '../entities/suscripcion.entity';
import { GOOGLE_PLAY_API } from '../verificadores/google-play-api';
import type {
  GooglePlayApi,
  SuscripcionGoogle,
} from '../verificadores/google-play-api';
import {
  dineroANumero,
  estadoHttp,
  MENSAJE_TIENDA_NO_DISPONIBLE,
} from '../verificadores/verificador-google';
import { FUENTE_ESTADO_GOOGLE } from './fuente-estado-google';
import type { FuenteEstadoGoogle } from './fuente-estado-google';
import { decodificarMensaje } from './rtdn.types';
import type { MensajeDecodificado } from './rtdn.types';
import { transicionDesdeGoogle, TIPOS_REEMBOLSO } from './transicion';
import type { ContextoTransicion } from './transicion';

/** Códigos HTTP con los que Google dice "esa compra no existe / no es válida". */
const HTTP_TOKEN_INVALIDO = new Set([400, 404, 410]);
const PRODUCT_TYPE_SUSCRIPCION = 1;

export interface ResultadoEvento {
  resultado: string;
  usuarioId: string | null;
  compraId: string | null;
}

export type ResultadoProcesamiento =
  { duplicado: true } | { duplicado: false; resultado: string };

function sinEvento(resultado: string): ResultadoEvento {
  return { resultado, usuarioId: null, compraId: null };
}

/** Errores de conexión o de concurrencia de Postgres: se reintentan (503). */
function esErrorTransitorioDeBd(error: unknown): boolean {
  if (error instanceof QueryFailedError) {
    const codigo = (error.driverError as { code?: string } | undefined)?.code;
    return (
      typeof codigo === 'string' &&
      (/^(08|53|57)/.test(codigo) || codigo === '40001' || codigo === '40P01')
    );
  }
  const e = error as { code?: unknown; message?: unknown } | null;
  if (typeof e?.code === 'string' && /^E(CONN|TIMEDOUT|PIPE)/.test(e.code)) {
    return true;
  }
  return (
    typeof e?.message === 'string' &&
    /Connection terminated|connection timeout/i.test(e.message)
  );
}

/** Texto para `eventos_tienda.error`: nunca el mensaje de librerías (pueden traer el token). */
function textoDeError(error: unknown): string {
  if (error instanceof HttpException) {
    return `${error.constructor.name}: ${error.message}`.slice(0, 300);
  }
  if (error instanceof QueryFailedError) {
    const codigo = (error.driverError as { code?: string } | undefined)?.code;
    return `QueryFailedError (${codigo ?? 'sin código'})`;
  }
  return (error instanceof Error ? error.constructor.name : 'Error').slice(
    0,
    100,
  );
}

/**
 * Procesa los avisos RTDN de Google Play (etapa 5). Idempotente por
 * `message_id`; SIEMPRE re-consulta el estado a Google (el orden de llegada de
 * los avisos no importa). Ver `src/suscripciones/README.md`.
 */
@Injectable()
export class RtdnService {
  private readonly logger = new Logger(RtdnService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Compra)
    private readonly compraRepository: Repository<Compra>,
    @InjectRepository(EventoTienda)
    private readonly eventoRepository: Repository<EventoTienda>,
    @InjectRepository(PagoHistorial)
    private readonly pagoRepository: Repository<PagoHistorial>,
    @Inject(CONFIG_SUSCRIPCION)
    private readonly config: ConfigSuscripcion,
    @Inject(FUENTE_ESTADO_GOOGLE)
    private readonly fuente: FuenteEstadoGoogle,
    @Inject(GOOGLE_PLAY_API)
    private readonly api: GooglePlayApi | null,
    private readonly cuentaOfuscada: CuentaOfuscadaService,
    private readonly compraSuscripcion: CompraSuscripcionService,
  ) {}

  /**
   * Registra el mensaje (idempotente) y lo procesa. Error transitorio →
   * 503 con el evento en `error` y `procesado_en` NULL; error inesperado →
   * 500 (Pub/Sub reintenta).
   */
  async procesar(
    messageId: string,
    data: string | undefined,
  ): Promise<ResultadoProcesamiento> {
    const decodificado = decodificarMensaje(data);
    const tipo = decodificado?.mensaje.tipo ?? 'DESCONOCIDO';
    const payload = decodificado?.payload ?? { invalido: true };

    const insertadas: Array<{ id: string }> = await this.dataSource.query(
      `INSERT INTO "eventos_tienda" ("tienda", "message_id", "tipo", "payload")
       VALUES ('google_play', $1, $2, $3)
       ON CONFLICT ("message_id") DO NOTHING
       RETURNING "id"`,
      [messageId, tipo, JSON.stringify(payload)],
    );
    if (insertadas.length === 0) {
      const previo = await this.eventoRepository.findOne({
        where: { messageId },
      });
      if (previo?.procesadoEn) {
        this.logger.log(`RTDN ${messageId}: duplicado, sin cambios`);
        return { duplicado: true };
      }
      // Recibido pero no procesado (un intento anterior falló): se reprocesa.
    }

    try {
      const salida = decodificado
        ? await this.ejecutar(decodificado)
        : sinEvento('mensaje_invalido');
      await this.eventoRepository.update(
        { messageId },
        {
          procesadoEn: new Date(),
          resultado: salida.resultado,
          usuarioId: salida.usuarioId,
          compraId: salida.compraId,
          error: null,
        },
      );
      this.logger.log(
        `RTDN ${messageId} ${tipo}: ${salida.resultado} (usuario ${salida.usuarioId ?? '-'}, compra ${salida.compraId ?? '-'})`,
      );
      return { duplicado: false, resultado: salida.resultado };
    } catch (error) {
      await this.eventoRepository
        .update(
          { messageId },
          { resultado: 'error', error: textoDeError(error) },
        )
        .catch(() => undefined);
      const transitorio =
        error instanceof ServiceUnavailableException ||
        esErrorTransitorioDeBd(error);
      this.logger.error(
        `RTDN ${messageId} ${tipo}: ${transitorio ? 'error transitorio (503)' : 'error inesperado (500)'} - ${textoDeError(error)}`,
      );
      if (error instanceof ServiceUnavailableException) throw error;
      if (transitorio) {
        throw new ServiceUnavailableException(MENSAJE_TIENDA_NO_DISPONIBLE);
      }
      throw error;
    }
  }

  private async ejecutar(d: MensajeDecodificado): Promise<ResultadoEvento> {
    const { mensaje } = d;
    if (
      this.config.paqueteAndroid !== null &&
      d.paquete !== null &&
      d.paquete !== this.config.paqueteAndroid
    ) {
      return sinEvento('paquete_ajeno');
    }

    switch (mensaje.clase) {
      case 'prueba':
        return sinEvento('prueba');
      case 'otro':
        return sinEvento('ignorado');
      case 'voided':
        if (
          mensaje.productType !== PRODUCT_TYPE_SUSCRIPCION ||
          mensaje.orderId === ''
        ) {
          return sinEvento('ignorado');
        }
        if (mensaje.refundType === 2) {
          this.logger.warn(
            `Aviso de reembolso parcial (refundType 2) del pedido ${mensaje.orderId}: se trata como cualquier reembolso (F3)`,
          );
        }
        return this.procesarSuscripcion({
          token: mensaje.token,
          tipo: mensaje.tipo,
          tipoNumero: null,
          orderIdReembolso: mensaje.orderId,
          eventoEn: d.eventoEn,
        });
      case 'suscripcion':
        if (mensaje.ignorado) return sinEvento('ignorado');
        return this.procesarSuscripcion({
          token: mensaje.token,
          tipo: mensaje.tipo,
          tipoNumero: mensaje.tipoNumero,
          orderIdReembolso: null,
          eventoEn: d.eventoEn,
        });
    }
  }

  private async procesarSuscripcion(entrada: {
    token: string;
    tipo: string;
    tipoNumero: number | null;
    orderIdReembolso: string | null;
    eventoEn: Date | null;
  }): Promise<ResultadoEvento> {
    const compra = await this.compraRepository.findOne({
      where: { tienda: 'google_play', purchaseToken: entrada.token },
    });
    const esReembolso = TIPOS_REEMBOLSO.has(entrada.tipo);
    // Un reembolso de un token que no conocemos no liga nada (F5 no aplica).
    if (!compra && esReembolso) return sinEvento('compra_desconocida');

    const google = await this.consultarGoogle(
      entrada.token,
      entrada.tipoNumero,
      compra,
    );
    if (google === null) {
      // Google ya no conoce el token. Un reembolso de una compra propia se
      // aplica igual (no depende del estado que dé Google).
      if (compra && esReembolso) {
        return this.aplicar(compra, {}, entrada);
      }
      return sinEvento('token_invalido');
    }

    if (!compra) return this.compraNueva(entrada.token, google, entrada);
    if (compra.estado === 'pendiente') return this.delegar(compra);
    return this.aplicar(compra, google, entrada);
  }

  /** null = Google dice que el token no existe (400/404/410); otros fallos → 503. */
  private async consultarGoogle(
    token: string,
    tipoNumero: number | null,
    compra: Compra | null,
  ): Promise<SuscripcionGoogle | null> {
    try {
      return await this.fuente.obtener({
        token,
        productoId: this.config.productoSuscripcionId,
        tipoNotificacion: tipoNumero,
        compra: compra
          ? {
              estado: compra.estado,
              orderId: compra.orderId,
              periodoFin: compra.periodoFin,
            }
          : null,
      });
    } catch (error) {
      const http = estadoHttp(error);
      if (http !== null && HTTP_TOKEN_INVALIDO.has(http)) return null;
      this.logger.warn(
        `Google Play no disponible al consultar un aviso (http ${http ?? 'sin respuesta'})`,
      );
      throw new ServiceUnavailableException(MENSAJE_TIENDA_NO_DISPONIBLE);
    }
  }

  // ---------------------------------------------------------------- F5

  private async compraNueva(
    token: string,
    google: SuscripcionGoogle,
    entrada: { tipo: string; tipoNumero: number | null },
  ): Promise<ResultadoEvento> {
    const enlazado = google.linkedPurchaseToken ?? null;
    const expirado =
      google.outOfAppPurchaseContext?.expiredPurchaseToken ?? null;

    let usuarioId: string | null = null;
    let compraVieja: Compra | null = null;
    for (const candidato of [enlazado, expirado]) {
      if (!candidato || usuarioId) continue;
      const c = await this.compraRepository.findOne({
        where: { tienda: 'google_play', purchaseToken: candidato },
      });
      if (c) {
        usuarioId = c.usuarioId;
        if (candidato === enlazado) compraVieja = c;
      }
    }
    if (!usuarioId) {
      usuarioId = await this.buscarPorHmac([
        google.externalAccountIdentifiers?.obfuscatedExternalAccountId,
        google.outOfAppPurchaseContext?.expiredExternalAccountIdentifiers
          ?.obfuscatedExternalAccountId,
      ]);
    }
    if (!usuarioId) return sinEvento('compra_desconocida');

    const usuario = await this.dataSource.getRepository(Usuario).findOne({
      where: { id: usuarioId },
      select: { id: true, createdAt: true },
    });
    if (!usuario) return sinEvento('compra_desconocida');

    let resultado: string;
    try {
      const r = await this.compraSuscripcion.aplicarCompraDeTienda(
        usuario,
        this.config.productoSuscripcionId,
        token,
      );
      if (r === 'ignorada_mes_vigente') resultado = 'd2_ignorada';
      else if (r === 'ya_era_propia') {
        // Otro mensaje o el cliente la registró en paralelo: se aplica el estado.
        const propia = await this.compraRepository.findOne({
          where: { tienda: 'google_play', purchaseToken: token },
        });
        if (propia) {
          return this.aplicar(propia, google, {
            tipo: entrada.tipo,
            orderIdReembolso: null,
            eventoEn: null,
          });
        }
        resultado = 'aplicado';
      } else resultado = 'aplicado';

      if (resultado === 'aplicado' && compraVieja) {
        // La compra vieja pasa a `expirada` sin tocar la suscripción.
        await this.compraRepository.update(
          { id: compraVieja.id, estado: 'confirmada' },
          { estado: 'expirada' },
        );
      }
    } catch (error) {
      if (error instanceof BadRequestException) resultado = 'rechazada';
      else if (error instanceof ConflictException) resultado = 'conflicto';
      else throw error;
    }

    const creada = await this.compraRepository.findOne({
      where: { tienda: 'google_play', purchaseToken: token },
    });
    return { resultado, usuarioId, compraId: creada?.id ?? null };
  }

  private async buscarPorHmac(
    ids: Array<string | null | undefined>,
  ): Promise<string | null> {
    const buscados = new Set(ids.filter((i): i is string => !!i));
    if (buscados.size === 0) return null;
    // El volumen de cuentas es pequeño: se recorre calculando el HMAC.
    const usuarios = await this.dataSource
      .getRepository(Usuario)
      .find({ select: { id: true } });
    for (const u of usuarios) {
      if (buscados.has(this.cuentaOfuscada.calcular(u.id))) return u.id;
    }
    return null;
  }

  /** Compra propia `pendiente`: se vuelve a verificar con las reglas de validar-compra (D8/E12). */
  private async delegar(compra: Compra): Promise<ResultadoEvento> {
    const usuario = await this.dataSource.getRepository(Usuario).findOne({
      where: { id: compra.usuarioId },
      select: { id: true, createdAt: true },
    });
    if (!usuario) return sinEvento('compra_desconocida');
    let resultado: string;
    try {
      const r = await this.compraSuscripcion.aplicarCompraDeTienda(
        usuario,
        this.config.productoSuscripcionId,
        compra.purchaseToken,
      );
      resultado = r === 'ignorada_mes_vigente' ? 'd2_ignorada' : 'aplicado';
    } catch (error) {
      if (error instanceof BadRequestException) resultado = 'rechazada';
      else if (error instanceof ConflictException) resultado = 'conflicto';
      else throw error;
    }
    return { resultado, usuarioId: usuario.id, compraId: compra.id };
  }

  // -------------------------------------------------------------- 5.10

  /**
   * Revisión de respaldo (F6): re-consulta la compra vigente del usuario y
   * aplica el estado como un aviso `RECONCILIACION`. No crea fila en
   * `eventos_tienda`.
   */
  async reconciliar(usuarioId: string): Promise<string> {
    const compra = await this.compraRepository.findOne({
      where: { usuarioId, tienda: 'google_play', estado: 'confirmada' },
      order: { periodoFin: 'DESC' },
    });
    if (!compra) return 'sin_compra';
    const google = await this.consultarGoogle(
      compra.purchaseToken,
      null,
      compra,
    );
    if (google === null) return 'token_invalido';
    const r = await this.aplicar(compra, google, {
      tipo: 'RECONCILIACION',
      orderIdReembolso: null,
      eventoEn: null,
    });
    return r.resultado;
  }

  /** Aplica el estado de Google a una compra ya ligada (tabla de `transicion.ts`). */
  private async aplicar(
    compra: Compra,
    google: SuscripcionGoogle,
    entrada: {
      tipo: string;
      orderIdReembolso: string | null;
      eventoEn: Date | null;
    },
  ): Promise<ResultadoEvento> {
    const ahora = new Date();
    const productoId = this.config.productoSuscripcionId;
    const linea = google.lineItems?.find((i) => i.productId === productoId);
    const ultimoPedido = linea?.latestSuccessfulOrderId ?? null;

    // Llamadas a Google FUERA de la transacción: el monto del pedido nuevo.
    let pedido: ContextoTransicion['pedido'] = null;
    if (ultimoPedido !== null) {
      const registrado = await this.pagoRepository.exists({
        where: { tienda: 'google_play', externalId: ultimoPedido },
      });
      if (!registrado) {
        pedido = await this.leerPedido(
          ultimoPedido,
          linea?.autoRenewingPlan?.recurringPrice,
        );
      }
    }

    const orderIdReembolso =
      entrada.orderIdReembolso ??
      (TIPOS_REEMBOLSO.has(entrada.tipo)
        ? (ultimoPedido ?? compra.orderId)
        : null);

    const salida = await this.dataSource.transaction(async (manager) => {
      const suscripcionRepo = manager.getRepository(Suscripcion);
      const compraRepo = manager.getRepository(Compra);
      const pagoRepo = manager.getRepository(PagoHistorial);

      // Orden de locks: primero `suscripciones`, después `compras`.
      const fila = await suscripcionRepo.findOne({
        where: { usuarioId: compra.usuarioId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!fila) {
        throw new Error(
          `La suscripción del usuario ${compra.usuarioId} no existe`,
        );
      }
      const actual = await compraRepo.findOne({
        where: { id: compra.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!actual) return { resultado: 'ignorado', hayDosActivas: false };

      const otras = await compraRepo.count({
        where: {
          usuarioId: compra.usuarioId,
          estado: 'confirmada',
          id: Not(actual.id),
          periodoFin: MoreThan(ahora),
        },
      });
      const pedidoRegistrado =
        ultimoPedido !== null &&
        (await pagoRepo.exists({
          where: { tienda: 'google_play', externalId: ultimoPedido },
        }));

      const plan = transicionDesdeGoogle(
        fila,
        actual,
        google,
        entrada.tipo,
        ahora,
        otras > 0,
        {
          productoId,
          pedidoRegistrado,
          pedido: pedidoRegistrado ? null : pedido,
          eventoEn: entrada.eventoEn,
          orderIdReembolso,
        },
      );
      for (const aviso of plan.avisos) this.logger.warn(aviso);
      if (plan.resultado === 'ignorado') {
        return { resultado: 'ignorado', hayDosActivas: false };
      }
      if (plan.resultado === 'delegar_pendiente') {
        return { resultado: 'delegar', hayDosActivas: false };
      }

      let hayCambio = false;
      const cambiosSusc = plan.suscripcion;
      if (Object.keys(cambiosSusc).length > 0) {
        await suscripcionRepo.update(
          { id: fila.id },
          {
            ...cambiosSusc,
            // `estado_desde` solo cambia si cambia el estado.
            ...(cambiosSusc.estado !== undefined ? { estadoDesde: ahora } : {}),
          },
        );
        hayCambio = true;
      }
      if (Object.keys(plan.compra).length > 0) {
        await compraRepo.update({ id: actual.id }, plan.compra);
        hayCambio = true;
      }
      for (const pago of plan.pagos) {
        const insertadas: Array<{ id: string }> = await manager.query(
          `INSERT INTO "pagos_historial"
             ("usuario_id", "compra_id", "tienda", "external_id", "periodo",
              "cobrado_en", "monto", "moneda", "estado")
           VALUES ($1, $2, 'google_play', $3, $4, $5, $6, $7, $8)
           ON CONFLICT ("tienda", "external_id") DO NOTHING
           RETURNING "id"`,
          [
            compra.usuarioId,
            actual.id,
            pago.externalId,
            pago.periodo,
            pago.cobradoEn,
            pago.monto,
            pago.moneda,
            pago.estado,
          ],
        );
        if (insertadas.length > 0) hayCambio = true;
      }
      if (plan.reembolsarPago !== null) {
        const r = await pagoRepo.update(
          {
            tienda: 'google_play',
            externalId: plan.reembolsarPago,
            usuarioId: compra.usuarioId,
            estado: Not('reembolsado'),
          },
          { estado: 'reembolsado' },
        );
        if ((r.affected ?? 0) > 0) hayCambio = true;
      }

      const vigentes = await compraRepo.find({
        where: {
          usuarioId: compra.usuarioId,
          estado: 'confirmada',
          periodoFin: MoreThan(ahora),
        },
      });
      if (vigentes.length >= 2) {
        this.logger.warn(
          `El usuario ${compra.usuarioId} tiene ${vigentes.length} compras activas a la vez (R-2): pedidos ${vigentes.map((c) => c.orderId ?? '-').join(', ')}`,
        );
      }
      return {
        resultado: hayCambio ? 'aplicado' : 'sin_cambios',
        hayDosActivas: vigentes.length >= 2,
      };
    });

    if (salida.resultado === 'delegar') return this.delegar(compra);

    if (salida.resultado === 'aplicado' || salida.resultado === 'sin_cambios') {
      await this.reconocerSiHaceFalta(compra.id, google);
    }
    if (entrada.tipo !== 'RECONCILIACION' || salida.resultado === 'aplicado') {
      this.logger.log(
        `Compra ${compra.id} (usuario ${compra.usuarioId}, pedido ${ultimoPedido ?? '-'}): ${salida.resultado} por ${entrada.tipo}`,
      );
    }
    return {
      resultado: salida.resultado,
      usuarioId: compra.usuarioId,
      compraId: compra.id,
    };
  }

  /** Acknowledge de una compra confirmada que aún no está reconocida. */
  private async reconocerSiHaceFalta(
    compraId: string,
    google: SuscripcionGoogle,
  ): Promise<void> {
    const compra = await this.compraRepository.findOne({
      where: { id: compraId },
    });
    if (!compra || compra.estado !== 'confirmada' || compra.reconocidaEn)
      return;
    if (google.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED') {
      await this.compraRepository.update(
        { id: compra.id },
        { reconocidaEn: new Date() },
      );
      return;
    }
    await this.compraSuscripcion.reconocerSiHaceFalta(compra);
  }

  /** Total del pedido (orders.get); respaldo `recurringPrice`. Sin API (simulada) usa el precio recurrente. */
  private async leerPedido(
    orderId: string,
    recurrente:
      | {
          units?: string | null;
          nanos?: number | null;
          currencyCode?: string | null;
        }
      | null
      | undefined,
  ): Promise<ContextoTransicion['pedido']> {
    if (this.api !== null) {
      try {
        const orden = await this.api.obtenerPedido(orderId);
        const monto = orden.total ? dineroANumero(orden.total) : null;
        if (orden.total && monto !== null && orden.total.currencyCode) {
          const creada = orden.createTime ? new Date(orden.createTime) : null;
          return {
            monto,
            moneda: orden.total.currencyCode,
            creadoEn: creada && !Number.isNaN(creada.getTime()) ? creada : null,
          };
        }
      } catch (error) {
        this.logger.warn(
          `No se pudo leer el pedido ${orderId} (http ${estadoHttp(error) ?? 'sin respuesta'}); se usa el precio recurrente`,
        );
        return null;
      }
      return null;
    }
    const monto = recurrente ? dineroANumero(recurrente) : null;
    return monto !== null && recurrente?.currencyCode
      ? { monto, moneda: recurrente.currencyCode, creadoEn: null }
      : null;
  }
}
