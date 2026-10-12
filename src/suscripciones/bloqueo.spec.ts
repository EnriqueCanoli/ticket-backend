import { ESTADOS_BLOQUEADOS, esEstadoBloqueado } from './bloqueo';
import type { EstadoSuscripcionServidor } from './interfaces/suscripcion-response.interface';

describe('esEstadoBloqueado', () => {
  const casos: Array<[EstadoSuscripcionServidor, boolean]> = [
    ['prueba', false],
    ['activa', false],
    ['cancelada', false],
    ['prueba_vencida', true],
    ['vencida', true],
    ['pago_en_proceso', true],
  ];

  it.each(casos)('%s -> %s', (estado, esperado) => {
    expect(esEstadoBloqueado(estado)).toBe(esperado);
  });

  it('ESTADOS_BLOQUEADOS contiene exactamente los 3 estados bloqueados', () => {
    expect([...ESTADOS_BLOQUEADOS].sort()).toEqual([
      'pago_en_proceso',
      'prueba_vencida',
      'vencida',
    ]);
  });
});
