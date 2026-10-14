import type { ConfigSuscripcion } from '../config-suscripcion';
import { ReconciliacionService } from './reconciliacion.service';

const base: ConfigSuscripcion = {
  validacionTienda: 'google',
  productoSuscripcionId: 'ticket_mensual',
  paqueteAndroid: 'com.canales.ticket',
  credencialesGoogle: null,
  hmacSecreto: 'x'.repeat(32),
  pubsubAudiencia: null,
  pubsubEmail: null,
  rtdnVerificarOidc: true,
};
const AHORA = new Date('2026-04-20T12:00:00-06:00');

function construir(modo: 'google' | 'simulada' = 'google') {
  const reconciliar = jest.fn().mockResolvedValue('aplicado');
  const servicio = new ReconciliacionService(
    { ...base, validacionTienda: modo },
    { reconciliar } as never,
  );
  return { servicio, reconciliar };
}

const snapshot = (acceso: string | null, extra = {}) => ({
  estado: 'activa' as const,
  renovacion_automatica: true,
  acceso_hasta: acceso,
  ...extra,
});

describe('ReconciliacionService (F6)', () => {
  it('una cuenta al día nunca consulta a Google', () => {
    const { servicio, reconciliar } = construir();
    expect(
      servicio.revisarSiHaceFalta(
        'u1',
        snapshot('2026-04-25T12:00:00-06:00'),
        AHORA,
      ),
    ).toBe(false);
    expect(reconciliar).not.toHaveBeenCalled();
  });

  it('dentro del margen de 1 hora tampoco consulta', () => {
    const { servicio, reconciliar } = construir();
    expect(
      servicio.revisarSiHaceFalta(
        'u1',
        snapshot('2026-04-20T11:30:00-06:00'),
        AHORA,
      ),
    ).toBe(false);
    expect(reconciliar).not.toHaveBeenCalled();
  });

  it('consulta si acceso_hasta + 1 hora ya pasó', () => {
    const { servicio, reconciliar } = construir();
    expect(
      servicio.revisarSiHaceFalta(
        'u1',
        snapshot('2026-04-20T10:30:00-06:00'),
        AHORA,
      ),
    ).toBe(true);
    expect(reconciliar).toHaveBeenCalledWith('u1');
  });

  it('no repite dentro de 24 horas y sí después', () => {
    const { servicio, reconciliar } = construir();
    const vencida = snapshot('2026-04-20T10:30:00-06:00');
    expect(servicio.revisarSiHaceFalta('u1', vencida, AHORA)).toBe(true);
    expect(
      servicio.revisarSiHaceFalta(
        'u1',
        vencida,
        new Date(AHORA.getTime() + 23 * 3_600_000),
      ),
    ).toBe(false);
    expect(
      servicio.revisarSiHaceFalta(
        'u2',
        vencida,
        new Date(AHORA.getTime() + 23 * 3_600_000),
      ),
    ).toBe(true);
    expect(
      servicio.revisarSiHaceFalta(
        'u1',
        vencida,
        new Date(AHORA.getTime() + 25 * 3_600_000),
      ),
    ).toBe(true);
    expect(reconciliar).toHaveBeenCalledTimes(3);
  });

  it('no consulta en modo simulada', () => {
    const { servicio, reconciliar } = construir('simulada');
    expect(
      servicio.revisarSiHaceFalta(
        'u1',
        snapshot('2026-04-01T10:30:00-06:00'),
        AHORA,
      ),
    ).toBe(false);
    expect(reconciliar).not.toHaveBeenCalled();
  });

  it('solo cuentas activas con renovación', () => {
    const { servicio, reconciliar } = construir();
    const vencido = '2026-04-01T10:30:00-06:00';
    expect(
      servicio.revisarSiHaceFalta(
        'u1',
        snapshot(vencido, { renovacion_automatica: false }),
        AHORA,
      ),
    ).toBe(false);
    expect(
      servicio.revisarSiHaceFalta(
        'u1',
        snapshot(vencido, { estado: 'vencida' }),
        AHORA,
      ),
    ).toBe(false);
    expect(servicio.revisarSiHaceFalta('u1', snapshot(null), AHORA)).toBe(
      false,
    );
    expect(reconciliar).not.toHaveBeenCalled();
  });

  it('un fallo en segundo plano no se propaga', async () => {
    const reconciliar = jest.fn().mockRejectedValue(new Error('google caído'));
    const servicio = new ReconciliacionService(base, { reconciliar } as never);
    expect(
      servicio.revisarSiHaceFalta(
        'u1',
        snapshot('2026-04-01T10:30:00-06:00'),
        AHORA,
      ),
    ).toBe(true);
    await new Promise((r) => setImmediate(r));
  });
});
