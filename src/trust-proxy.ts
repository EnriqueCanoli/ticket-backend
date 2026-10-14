/**
 * Interpreta la variable `TRUST_PROXY` (número de proxies de confianza delante de la app; en
 * Render es 1). Ausente o vacía: `null` (no se toca la configuración de Express). Un entero >= 0:
 * ese número. Cualquier otro valor lanza un Error cuyo mensaje NO incluye el valor recibido.
 */
export function leerTrustProxy(valor?: string): number | null {
  if (valor === undefined) return null;
  const texto = valor.trim();
  if (texto === '') return null;
  if (!/^\d+$/.test(texto)) {
    throw new Error('TRUST_PROXY debe ser un entero mayor o igual a 0');
  }
  const numero = Number(texto);
  if (!Number.isSafeInteger(numero)) {
    throw new Error('TRUST_PROXY debe ser un entero mayor o igual a 0');
  }
  return numero;
}
