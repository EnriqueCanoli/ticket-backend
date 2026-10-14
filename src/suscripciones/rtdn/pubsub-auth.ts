import {
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * Verificación del token OIDC que Pub/Sub adjunta a cada push
 * (`Authorization: Bearer <JWT>`). Los tests siempre sobrescriben
 * `VERIFICADOR_PUSH`.
 */
export interface VerificadorPush {
  /** Lanza `UnauthorizedException` (401) o `ServiceUnavailableException` (503). */
  verificar(authorization?: string): Promise<void>;
}

export const VERIFICADOR_PUSH = Symbol('VERIFICADOR_PUSH');

export const MENSAJE_PUSH_NO_AUTORIZADO =
  'PUSH_NO_AUTORIZADO: el aviso no trae una firma válida de Google';
export const MENSAJE_CERTIFICADOS_NO_DISPONIBLES =
  'CERTIFICADOS_NO_DISPONIBLES: no se pudieron obtener los certificados de Google';

/** Parte mínima de `OAuth2Client` que usa el verificador (facilita los tests). */
export interface ClienteIdToken {
  verifyIdToken(opciones: {
    idToken: string;
    audience: string;
  }): Promise<{ getPayload(): TokenPayloadMinimo | undefined }>;
}

export interface TokenPayloadMinimo {
  email?: string;
  email_verified?: boolean;
}

const CODIGOS_RED = new Set([
  'ENOTFOUND',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ECONNABORTED',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * `true` si el fallo fue al obtener los certificados de Google (red o 5xx) y
 * no un problema del token. La librería antepone "Failed to retrieve
 * verification certificates" a ese error.
 */
export function esFalloDeCertificados(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as {
    message?: unknown;
    code?: unknown;
    status?: unknown;
    cause?: unknown;
    response?: { status?: unknown };
  };
  if (
    typeof e.message === 'string' &&
    e.message.startsWith('Failed to retrieve verification certificates')
  ) {
    return true;
  }
  if (typeof e.code === 'string' && CODIGOS_RED.has(e.code)) return true;
  const http = e.response?.status ?? e.status;
  if (typeof http === 'number' && (http >= 500 || http === 429)) return true;
  return e.cause !== undefined && esFalloDeCertificados(e.cause);
}

const PATRON_BEARER = /^Bearer (.+)$/;

/**
 * Valida firma, expiración, emisor y audiencia con `verifyIdToken` y exige
 * además `email === PUBSUB_PUSH_EMAIL` y `email_verified === true`. Si falta
 * la audiencia o el correo configurados, rechaza todo (401). NUNCA registra el
 * header ni el token (los mensajes de la librería pueden contenerlo).
 */
export class VerificadorPushOidc implements VerificadorPush {
  private readonly logger = new Logger(VerificadorPushOidc.name);

  constructor(
    private readonly audiencia: string | null,
    private readonly email: string | null,
    private readonly cliente: ClienteIdToken,
  ) {}

  async verificar(authorization?: string): Promise<void> {
    const coincidencia =
      typeof authorization === 'string'
        ? PATRON_BEARER.exec(authorization)
        : null;
    if (!coincidencia || this.audiencia === null || this.email === null) {
      throw new UnauthorizedException(MENSAJE_PUSH_NO_AUTORIZADO);
    }

    let payload: TokenPayloadMinimo | undefined;
    try {
      const ticket = await this.cliente.verifyIdToken({
        idToken: coincidencia[1],
        audience: this.audiencia,
      });
      payload = ticket.getPayload();
    } catch (error) {
      if (esFalloDeCertificados(error)) {
        this.logger.warn(
          'No se pudieron obtener los certificados de Google para verificar un push',
        );
        throw new ServiceUnavailableException(
          MENSAJE_CERTIFICADOS_NO_DISPONIBLES,
        );
      }
      throw new UnauthorizedException(MENSAJE_PUSH_NO_AUTORIZADO);
    }

    if (
      !payload ||
      payload.email !== this.email ||
      payload.email_verified !== true
    ) {
      throw new UnauthorizedException(MENSAJE_PUSH_NO_AUTORIZADO);
    }
  }
}

/** Modo `simulada` fuera de producción: no se verifica nada (F12). */
export class VerificadorPushDesactivado implements VerificadorPush {
  verificar(): Promise<void> {
    return Promise.resolve();
  }
}
