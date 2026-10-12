import { aIsoNegocio, finDePrueba, periodoNegocio } from './fechas';

describe('finDePrueba', () => {
  it('3 de marzo 09:12 (-06:00) → 16 de marzo 23:59:59-06:00', () => {
    const fin = finDePrueba(new Date('2026-03-03T09:12:00-06:00'));
    expect(aIsoNegocio(fin)).toBe('2026-03-16T23:59:59-06:00');
    expect(fin.toISOString()).toBe('2026-03-17T05:59:59.000Z');
  });

  it('3 de marzo 23:30 (-06:00), que en UTC ya es 4 de marzo, sigue siendo el 16', () => {
    const inicio = new Date('2026-03-03T23:30:00-06:00');
    expect(inicio.toISOString()).toBe('2026-03-04T05:30:00.000Z');
    expect(aIsoNegocio(finDePrueba(inicio))).toBe('2026-03-16T23:59:59-06:00');
  });

  it('4 de marzo 00:10 (-06:00) → 17 de marzo', () => {
    expect(
      aIsoNegocio(finDePrueba(new Date('2026-03-04T00:10:00-06:00'))),
    ).toBe('2026-03-17T23:59:59-06:00');
  });

  it('cambio de año: 25 de diciembre de 2026 → 7 de enero de 2027', () => {
    expect(
      aIsoNegocio(finDePrueba(new Date('2026-12-25T12:00:00-06:00'))),
    ).toBe('2027-01-07T23:59:59-06:00');
  });

  it('devuelve exactamente .000 ms', () => {
    expect(
      finDePrueba(new Date('2026-03-03T09:12:34.567-06:00')).getMilliseconds(),
    ).toBe(0);
  });
});

describe('aIsoNegocio', () => {
  it('formatea sin milisegundos y con -06:00', () => {
    const iso = aIsoNegocio(new Date('2026-03-10T16:00:00.789Z'));
    expect(iso).toBe('2026-03-10T10:00:00-06:00');
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-06:00$/);
  });

  it('cruza el día hacia atrás respecto de UTC', () => {
    expect(aIsoNegocio(new Date('2026-04-01T03:00:00Z'))).toBe(
      '2026-03-31T21:00:00-06:00',
    );
  });
});

describe('periodoNegocio', () => {
  it('en el borde de mes usa la zona de negocio: 2026-04-01T03:00:00Z → 2026-03', () => {
    expect(periodoNegocio(new Date('2026-04-01T03:00:00Z'))).toBe('2026-03');
  });

  it('06:00Z del 1 de abril ya es abril en la zona de negocio', () => {
    expect(periodoNegocio(new Date('2026-04-01T06:00:00Z'))).toBe('2026-04');
  });
});
