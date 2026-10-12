export type ModoValidacionTienda = 'simulada' | 'google';

export interface ConfigSuscripcion {
  validacionTienda: ModoValidacionTienda;
  productoSuscripcionId: string;
}

export const CONFIG_SUSCRIPCION = Symbol('CONFIG_SUSCRIPCION');

/** Id de producto provisional (el mismo que envía hoy el frontend). */
export const PRODUCTO_PROVISIONAL = 'PENDIENTE';

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
 *   producción; `simulada` en producción → error; `google` → error hasta la
 *   etapa 4b; cualquier otro valor → error.
 * - `PRODUCTO_SUSCRIPCION_ID`: ausente → `PENDIENTE` fuera de producción;
 *   ausente o `PENDIENTE` en producción → error.
 */
export function leerConfigSuscripcion(env: {
  NODE_ENV?: string;
  VALIDACION_TIENDA?: string;
  PRODUCTO_SUSCRIPCION_ID?: string;
}): ConfigSuscripcion {
  const produccion = env.NODE_ENV === 'production';
  const modo = valor(env.VALIDACION_TIENDA);
  const producto = valor(env.PRODUCTO_SUSCRIPCION_ID);

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
    throw new Error('VALIDACION_TIENDA=google se implementa en la etapa 4b');
  } else {
    throw new Error(
      `VALIDACION_TIENDA inválida: valores admitidos: ${MODOS_ADMITIDOS.join(', ')}`,
    );
  }

  if (
    produccion &&
    (producto === undefined || producto === PRODUCTO_PROVISIONAL)
  ) {
    throw new Error(
      'PRODUCTO_SUSCRIPCION_ID no configurada (o provisional): requerida en producción',
    );
  }

  return {
    validacionTienda,
    productoSuscripcionId: producto ?? PRODUCTO_PROVISIONAL,
  };
}
