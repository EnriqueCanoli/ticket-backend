import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG_SUSCRIPCION } from '../config-suscripcion';
import type { ConfigSuscripcion } from '../config-suscripcion';
import type { SuscripcionSnapshot } from '../interfaces/suscripcion-response.interface';
import { RtdnService } from './rtdn.service';

const MARGEN_MS = 3_600_000; // 1 hora
const INTERVALO_MS = 24 * 3_600_000; // máximo una vez cada 24 horas por usuario

/**
 * Revisión de respaldo (F6) por si se pierde un aviso RTDN: cuando el cliente
 * consulta su suscripción y la fila sigue `activa` con renovación aunque
 * `acceso_hasta + 1 hora` ya pasó, se re-consulta la compra a Google en
 * segundo plano. Es un servicio aparte para no cambiar el constructor de
 * `SuscripcionesService` (sus specs lo construyen con `new`). Las cuentas al
 * día nunca generan consultas a Google. Solo en modo `google`.
 *
 * El registro de la última revisión vive en memoria: se reinicia con el
 * proceso (y no se comparte entre instancias).
 */
@Injectable()
export class ReconciliacionService {
  private readonly logger = new Logger(ReconciliacionService.name);
  private readonly ultimaRevision = new Map<string, number>();

  constructor(
    @Inject(CONFIG_SUSCRIPCION) private readonly config: ConfigSuscripcion,
    private readonly rtdnService: RtdnService,
  ) {}

  /** Decide con el snapshot ya calculado y, si procede, lanza la revisión sin esperarla. */
  revisarSiHaceFalta(
    usuarioId: string,
    snapshot: Pick<
      SuscripcionSnapshot,
      'estado' | 'renovacion_automatica' | 'acceso_hasta'
    >,
    ahora: Date = new Date(),
  ): boolean {
    if (this.config.validacionTienda !== 'google') return false;
    if (
      snapshot.estado !== 'activa' ||
      !snapshot.renovacion_automatica ||
      snapshot.acceso_hasta === null
    ) {
      return false;
    }
    const acceso = new Date(snapshot.acceso_hasta).getTime();
    if (Number.isNaN(acceso) || acceso + MARGEN_MS >= ahora.getTime()) {
      return false;
    }
    const ultima = this.ultimaRevision.get(usuarioId);
    if (ultima !== undefined && ahora.getTime() - ultima < INTERVALO_MS) {
      return false;
    }
    this.ultimaRevision.set(usuarioId, ahora.getTime());

    void this.rtdnService
      .reconciliar(usuarioId)
      .then((resultado) =>
        this.logger.log(
          `Revisión de respaldo del usuario ${usuarioId}: ${resultado}`,
        ),
      )
      .catch((error: unknown) =>
        this.logger.warn(
          `Revisión de respaldo del usuario ${usuarioId} fallida: ${error instanceof Error ? error.constructor.name : 'error'}`,
        ),
      );
    return true;
  }
}
