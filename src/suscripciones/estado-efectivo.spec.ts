import { estadoEfectivo } from './estado-efectivo';
import type { Suscripcion } from './entities/suscripcion.entity';

/**
 * Tabla de la sección 1.3 de flujo_suscripcion.md con fixtures del 3 de
 * marzo (prueba hasta el 16 de marzo 23:59:59-06:00).
 */

const PRUEBA_FIN = new Date('2026-03-16T23:59:59-06:00');
const ACCESO_HASTA = new Date('2026-04-14T14:05:00-06:00');

type Fila = Pick<
  Suscripcion,
  'estado' | 'motivo' | 'pruebaFin' | 'accesoHasta' | 'renovacionAutomatica'
>;

function fila(overrides: Partial<Fila> = {}): Fila {
  return {
    estado: 'prueba',
    motivo: null,
    pruebaFin: PRUEBA_FIN,
    accesoHasta: null,
    renovacionAutomatica: false,
    ...overrides,
  };
}

describe('estadoEfectivo', () => {
  describe('prueba', () => {
    it('antes de prueba_fin sigue en prueba', () => {
      expect(
        estadoEfectivo(fila(), new Date('2026-03-10T10:00:00-06:00')),
      ).toEqual({ estado: 'prueba', motivo: null });
    });

    it('justo en prueba_fin sigue en prueba (comparación estricta)', () => {
      expect(estadoEfectivo(fila(), PRUEBA_FIN)).toEqual({
        estado: 'prueba',
        motivo: null,
      });
    });

    it('un milisegundo después de prueba_fin pasa a prueba_vencida / prueba_terminada', () => {
      expect(
        estadoEfectivo(fila(), new Date(PRUEBA_FIN.getTime() + 1)),
      ).toEqual({ estado: 'prueba_vencida', motivo: 'prueba_terminada' });
    });

    it('el 17 de marzo a las 00:00 está vencida', () => {
      expect(
        estadoEfectivo(fila(), new Date('2026-03-17T00:00:00-06:00')),
      ).toEqual({ estado: 'prueba_vencida', motivo: 'prueba_terminada' });
    });
  });

  describe('cancelada', () => {
    const base = { estado: 'cancelada' as const, renovacionAutomatica: false };

    it('con acceso_hasta futuro sigue cancelada', () => {
      expect(
        estadoEfectivo(
          fila({ ...base, accesoHasta: ACCESO_HASTA }),
          new Date('2026-04-01T09:00:00-06:00'),
        ),
      ).toEqual({ estado: 'cancelada', motivo: null });
    });

    it('con acceso_hasta pasado pasa a vencida / cancelada', () => {
      expect(
        estadoEfectivo(
          fila({ ...base, accesoHasta: ACCESO_HASTA }),
          new Date('2026-04-15T09:00:00-06:00'),
        ),
      ).toEqual({ estado: 'vencida', motivo: 'cancelada' });
    });

    it('con acceso_hasta null no vence por fecha', () => {
      expect(
        estadoEfectivo(
          fila({ ...base, accesoHasta: null }),
          new Date('2030-01-01T00:00:00-06:00'),
        ),
      ).toEqual({ estado: 'cancelada', motivo: null });
    });
  });

  describe('activa', () => {
    it('sin renovación y con acceso_hasta futuro sigue activa', () => {
      expect(
        estadoEfectivo(
          fila({
            estado: 'activa',
            renovacionAutomatica: false,
            accesoHasta: ACCESO_HASTA,
          }),
          new Date('2026-04-01T09:00:00-06:00'),
        ),
      ).toEqual({ estado: 'activa', motivo: null });
    });

    it('sin renovación y con acceso_hasta vencido pasa a vencida / cancelada', () => {
      expect(
        estadoEfectivo(
          fila({
            estado: 'activa',
            renovacionAutomatica: false,
            accesoHasta: ACCESO_HASTA,
          }),
          new Date('2026-04-15T09:00:00-06:00'),
        ),
      ).toEqual({ estado: 'vencida', motivo: 'cancelada' });
    });

    it('con renovación y fecha pasada sigue activa (no vence por fecha)', () => {
      expect(
        estadoEfectivo(
          fila({
            estado: 'activa',
            renovacionAutomatica: true,
            accesoHasta: ACCESO_HASTA,
          }),
          new Date('2026-06-01T09:00:00-06:00'),
        ),
      ).toEqual({ estado: 'activa', motivo: null });
    });
  });

  describe('estados que se conservan', () => {
    const ahora = new Date('2026-06-01T09:00:00-06:00');

    it('vencida conserva estado y motivo guardados', () => {
      expect(
        estadoEfectivo(
          fila({ estado: 'vencida', motivo: 'cobro_fallido' }),
          ahora,
        ),
      ).toEqual({ estado: 'vencida', motivo: 'cobro_fallido' });
    });

    it('pago_en_proceso se conserva', () => {
      expect(
        estadoEfectivo(fila({ estado: 'pago_en_proceso' }), ahora),
      ).toEqual({ estado: 'pago_en_proceso', motivo: null });
    });

    it('prueba_vencida guardada se conserva', () => {
      expect(
        estadoEfectivo(
          fila({ estado: 'prueba_vencida', motivo: 'prueba_terminada' }),
          ahora,
        ),
      ).toEqual({ estado: 'prueba_vencida', motivo: 'prueba_terminada' });
    });
  });
});
