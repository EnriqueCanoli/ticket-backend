export type ModoValidacionTienda = 'simulada' | 'google';

export interface CredencialesGoogle {
  client_email: string;
  private_key: string;
}

export interface ConfigSuscripcion {
  validacionTienda: ModoValidacionTienda;
  productoSuscripcionId: string;
  /** `PLAY_PACKAGE_NAME`; null si no se configuró (solo obligatorio con `google`). */
  paqueteAndroid: string | null;
  /** Cuenta de servicio ya decodificada; null fuera del modo `google`. */
  credencialesGoogle: CredencialesGoogle | null;
  /** Secreto del HMAC de `cuenta_ofuscada` (nunca se rota). */
  hmacSecreto: string;
  /** `PUBSUB_PUSH_AUDIENCIA` (etapa 5); null si no se configuró. */
  pubsubAudiencia: string | null;
  /** `PUBSUB_PUSH_EMAIL`: cuenta de servicio que firma el push; null si no se configuró. */
  pubsubEmail: string | null;
  /**
   * `true` si el endpoint RTDN verifica el token OIDC de Pub/Sub. Solo es
   * `false` en modo `simulada` (que nunca se admite en producción), para
   * probar con curl.
   */
  rtdnVerificarOidc: boolean;
}

export const CONFIG_SUSCRIPCION = Symbol('CONFIG_SUSCRIPCION');

/** Id de producto provisional (el mismo que envía hoy el frontend). */
export const PRODUCTO_PROVISIONAL = 'PENDIENTE';

/**
 * Secreto de DESARROLLO para el HMAC cuando no se configura
 * `SUSCRIPCION_HMAC_SECRETO` (solo fuera de producción y en modo simulado).
 */
export const HMAC_SECRETO_DESARROLLO =
  'secreto-de-desarrollo-no-usar-en-produccion-0123456789';

export const LONGITUD_MINIMA_HMAC = 32;

const MODOS_ADMITIDOS: readonly string[] = ['simulada', 'google'];

/** Igual que `mail.service.ts`: una variable vacía cuenta como ausente. */
function valor(texto: string | undefined): string | undefined {
  return texto === undefined || texto === '' ? undefined : texto;
}

/**
 * Lee y valida la configuración de la suscripción (función pura, testeable).
 * Un `throw` aquí hace fallar el arranque (fail-fast), como `MailService`
 * con `BREVO_API_KEY`.
 *
 * - `VALIDACION_TIENDA`: ausente → `simulada` fuera de producción y error en
 *   producción; `simulada` en producción → error; `google` exige credenciales,
 *   paquete, secreto HMAC y un producto real; cualquier otro valor → error.
 * - `PRODUCTO_SUSCRIPCION_ID`: ausente → `PENDIENTE` fuera de producción;
 *   ausente o `PENDIENTE` en producción o con `google` → error.
 * - `SUSCRIPCION_HMAC_SECRETO` (≥ 32 caracteres): obligatorio en producción y
 *   con `google`; en otro caso, ausente → constante de desarrollo.
 *
 * Los mensajes de error NUNCA incluyen el valor de una variable ni
 * fragmentos del JSON de credenciales.
 */
export function leerConfigSuscripcion(env: {
  NODE_ENV?: string;
  VALIDACION_TIENDA?: string;
  PRODUCTO_SUSCRIPCION_ID?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  PLAY_PACKAGE_NAME?: string;
  SUSCRIPCION_HMAC_SECRETO?: string;
  PUBSUB_PUSH_AUDIENCIA?: string;
  PUBSUB_PUSH_EMAIL?: string;
}): ConfigSuscripcion {
  const produccion = env.NODE_ENV === 'production';
  const modo = valor(env.VALIDACION_TIENDA);
  const producto = valor(env.PRODUCTO_SUSCRIPCION_ID);
  const paquete = valor(env.PLAY_PACKAGE_NAME);
  const secreto = valor(env.SUSCRIPCION_HMAC_SECRETO);
  const credencialesBase64 = valor(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const pubsubAudiencia = valor(env.PUBSUB_PUSH_AUDIENCIA);
  const pubsubEmail = valor(env.PUBSUB_PUSH_EMAIL);

  let validacionTienda: ModoValidacionTienda;
  if (modo === undefined) {
    if (produccion) {
      throw new Error(
        'VALIDACION_TIENDA no configurada: requerida en producción',
      );
    }
    validacionTienda = 'simulada';
  } else if (modo === 'simulada') {
    if (produccion) {
      throw new Error(
        'VALIDACION_TIENDA=simulada no está permitida en producción',
      );
    }
    validacionTienda = 'simulada';
  } else if (modo === 'google') {
    validacionTienda = 'google';
  } else {
    throw new Error(
      `VALIDACION_TIENDA inválida: valores admitidos: ${MODOS_ADMITIDOS.join(', ')}`,
    );
  }

  const esGoogle = validacionTienda === 'google';

  if (
    (produccion || esGoogle) &&
    (producto === undefined || producto === PRODUCTO_PROVISIONAL)
  ) {
    throw new Error(
      `PRODUCTO_SUSCRIPCION_ID no configurada (o provisional): requerida en ${esGoogle ? 'modo google' : 'producción'}`,
    );
  }

  if ((produccion || esGoogle) && secreto === undefined) {
    throw new Error('SUSCRIPCION_HMAC_SECRETO no configurada: es obligatoria');
  }
  if (
    (produccion || esGoogle) &&
    (secreto?.length ?? 0) < LONGITUD_MINIMA_HMAC
  ) {
    throw new Error(
      `SUSCRIPCION_HMAC_SECRETO demasiado corta: mínimo ${LONGITUD_MINIMA_HMAC} caracteres`,
    );
  }

  // Etapa 5 (F10): obligatorias en producción; en modo google fuera de
  // producción son opcionales (si faltan, el endpoint RTDN responde 401 a todo
  // y el módulo avisa al arrancar).
  if (produccion && pubsubAudiencia === undefined) {
    throw new Error(
      'PUBSUB_PUSH_AUDIENCIA no configurada: requerida en producción',
    );
  }
  if (produccion && pubsubEmail === undefined) {
    throw new Error(
      'PUBSUB_PUSH_EMAIL no configurada: requerida en producción',
    );
  }

  let credencialesGoogle: CredencialesGoogle | null = null;
  if (esGoogle) {
    if (paquete === undefined) {
      throw new Error(
        'PLAY_PACKAGE_NAME no configurada: requerida en modo google',
      );
    }
    credencialesGoogle = decodificarCredenciales(credencialesBase64);
  }

  return {
    validacionTienda,
    productoSuscripcionId: producto ?? PRODUCTO_PROVISIONAL,
    paqueteAndroid: paquete ?? null,
    credencialesGoogle,
    hmacSecreto: secreto ?? HMAC_SECRETO_DESARROLLO,
    pubsubAudiencia: pubsubAudiencia ?? null,
    pubsubEmail: pubsubEmail ?? null,
    rtdnVerificarOidc: esGoogle,
  };
}

/**
 * `GOOGLE_SERVICE_ACCOUNT_JSON` es el JSON de la cuenta de servicio en
 * base64 (una sola línea). Los errores no incluyen ningún fragmento del valor.
 */
function decodificarCredenciales(
  base64: string | undefined,
): CredencialesGoogle {
  if (base64 === undefined) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_JSON no configurada: requerida en modo google',
    );
  }
  let parseado: unknown;
  try {
    parseado = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  } catch {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_JSON inválida: debe ser el JSON de la cuenta de servicio en base64',
    );
  }
  const objeto = parseado as { client_email?: unknown; private_key?: unknown };
  if (
    typeof parseado !== 'object' ||
    parseado === null ||
    typeof objeto.client_email !== 'string' ||
    objeto.client_email === '' ||
    typeof objeto.private_key !== 'string' ||
    objeto.private_key === ''
  ) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_JSON inválida: faltan client_email o private_key',
    );
  }
  return {
    client_email: objeto.client_email,
    private_key: objeto.private_key,
  };
}
