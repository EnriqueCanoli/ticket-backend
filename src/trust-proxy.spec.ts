import { leerTrustProxy } from './trust-proxy';

describe('leerTrustProxy', () => {
  it('devuelve null si falta o está vacía', () => {
    expect(leerTrustProxy(undefined)).toBeNull();
    expect(leerTrustProxy('')).toBeNull();
    expect(leerTrustProxy('   ')).toBeNull();
  });

  it('devuelve el entero indicado', () => {
    expect(leerTrustProxy('0')).toBe(0);
    expect(leerTrustProxy('1')).toBe(1);
    expect(leerTrustProxy(' 2 ')).toBe(2);
  });

  it.each(['-1', '1.5', 'true', 'abc', '1e3', '99999999999999999999'])(
    'lanza un Error sin incluir el valor (%s)',
    (valor) => {
      expect(() => leerTrustProxy(valor)).toThrow(
        'TRUST_PROXY debe ser un entero mayor o igual a 0',
      );
      try {
        leerTrustProxy(valor);
      } catch (error) {
        expect((error as Error).message).not.toContain(valor);
      }
    },
  );
});
