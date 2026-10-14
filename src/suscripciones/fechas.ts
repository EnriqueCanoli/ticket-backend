/**
 * Fechas de la suscripción en la zona de negocio (centro de México).
 *
 * Desde 2022 México central equivale a UTC-6 fijo, sin horario de verano, así
 * que aquí se usa un desfase fijo, idéntico al del frontend
 * (`ZONA_NEGOCIO_OFFSET_MIN` en `src/shared/constants/subscription.ts` y
 * `aIsoNegocio` en `src/shared/utils/subscriptionDates.ts`). En SQL (backfill
 * y consultas) se usa la zona con nombre `America/Mexico_City`; ambos criterios
 * coinciden mientras no vuelva el horario de verano (riesgo R-7 de
 * docs/suscripcion/flujo_suscripcion.md, ver src/suscripciones/README.md).
 *
 * Un instante se "mueve" a la zona de negocio sumándole el desfase y se lee con
 * los getters UTC de `Date`.
 */

export const ZONA_NEGOCIO_OFFSET_MIN = -360;

const MS_POR_MINUTO = 60_000;
const MS_POR_DIA = 86_400_000;
const DESFASE_NEGOCIO_MS = ZONA_NEGOCIO_OFFSET_MIN * MS_POR_MINUTO;

/** Días de la prueba contando el día de inicio como el día 1. */
const DIAS_PRUEBA = 14;

function dosDigitos(valor: number): string {
  return String(valor).padStart(2, '0');
}

/** `Date` cuyos getters UTC devuelven la fecha y hora de la zona de negocio. */
function enZonaNegocio(fecha: Date): Date {
  return new Date(fecha.getTime() + DESFASE_NEGOCIO_MS);
}

/**
 * ISO 8601 con el desfase de la zona de negocio y sin milisegundos, ej.
 * `2026-03-16T23:59:59-06:00`. Mismo algoritmo que el frontend.
 */
export function aIsoNegocio(fecha: Date): string {
  const local = enZonaNegocio(fecha);
  const signo = ZONA_NEGOCIO_OFFSET_MIN < 0 ? '-' : '+';
  const absoluto = Math.abs(ZONA_NEGOCIO_OFFSET_MIN);
  const zona = `${signo}${dosDigitos(Math.floor(absoluto / 60))}:${dosDigitos(absoluto % 60)}`;
  return (
    `${local.getUTCFullYear()}-${dosDigitos(local.getUTCMonth() + 1)}-${dosDigitos(local.getUTCDate())}` +
    `T${dosDigitos(local.getUTCHours())}:${dosDigitos(local.getUTCMinutes())}:${dosDigitos(local.getUTCSeconds())}` +
    zona
  );
}

/**
 * Fin de la prueba: las 23:59:59.000 del día `inicio + 13` (el día de inicio
 * cuenta como el día 1) en la zona de negocio. Ej.: 3 de marzo 09:12 →
 * 16 de marzo 23:59:59-06:00. Equivale a la fórmula SQL del backfill.
 */
export function finDePrueba(inicio: Date): Date {
  const numeroDiaInicio = Math.floor(
    (inicio.getTime() + DESFASE_NEGOCIO_MS) / MS_POR_DIA,
  );
  const inicioDiaSiguienteAlFin =
    (numeroDiaInicio + DIAS_PRUEBA) * MS_POR_DIA - DESFASE_NEGOCIO_MS;
  return new Date(inicioDiaSiguienteAlFin - 1000);
}

/** Mes de una fecha en la zona de negocio, `YYYY-MM` (campo `periodo` del historial). */
export function periodoNegocio(fecha: Date): string {
  const local = enZonaNegocio(fecha);
  return `${local.getUTCFullYear()}-${dosDigitos(local.getUTCMonth() + 1)}`;
}

/**
 * Mismo día y hora del mes siguiente en la zona de negocio; si ese día no
 * existe, el último día del mes (31 de enero → 28 de febrero). Es el fin del
 * mes pagado (D3 de la etapa 4a).
 */
export function sumarUnMesNegocio(fecha: Date): Date {
  const local = enZonaNegocio(fecha);
  const anio = local.getUTCFullYear();
  const mes = local.getUTCMonth() + 1; // mes siguiente (puede ser 12 → enero)
  const diasDelMesSiguiente = new Date(Date.UTC(anio, mes + 1, 0)).getUTCDate();
  const dia = Math.min(local.getUTCDate(), diasDelMesSiguiente);
  const resultadoLocal = Date.UTC(
    anio,
    mes,
    dia,
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
    local.getUTCMilliseconds(),
  );
  return new Date(resultadoLocal - DESFASE_NEGOCIO_MS);
}
