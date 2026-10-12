import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type {
  GooglePlayApi,
  PedidoGoogle,
  SuscripcionGoogle,
} from './google-play-api';
import {
  dineroANumero,
  MENSAJE_TIENDA_NO_DISPONIBLE,
  VerificadorGoogle,
} from './verificador-google';

const PRODUCTO = 'ticket_mensual';
const TOKEN = 'token-de-prueba';
const AHORA = new Date('2026-10-12T12:00:00Z');
const FUTURO = '2026-11-12T12:00:00Z';
const PASADO = '2026-10-01T12:00:00Z';

function suscripcion(
  estado: string,
  opciones: {
    expiryTime?: string;
    autoRenew?: boolean;
    productId?: string;
    cuenta?: string | null;
    reconocida?: boolean;
    prueba?: boolean;
    orderId?: string | null;
  } = {},
): SuscripcionGoogle {
  return {
    subscriptionState: estado,
    startTime: '2026-10-12T11:59:00Z',
    acknowledgementState: opciones.reconocida
      ? 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'
      : 'ACKNOWLEDGEMENT_STATE_PENDING',
    ...(opciones.cuenta === null
      ? {}
      : {
          externalAccountIdentifiers: {
            obfuscatedExternalAccountId: opciones.cuenta ?? 'cuenta-hmac',
          },
        }),
    ...(opciones.prueba ? { testPurchase: {} } : {}),
    lineItems: [
      {
        productId: opciones.productId ?? PRODUCTO,
        expiryTime: opciones.expiryTime ?? FUTURO,
        latestSuccessfulOrderId:
          opciones.orderId === null ? null : (opciones.orderId ?? 'GPA.1234'),
        autoRenewingPlan: {
          autoRenewEnabled: opciones.autoRenew ?? true,
          recurringPrice: { currencyCode: 'MXN', units: '99', nanos: 0 },
        },
      },
    ],
  };
}

const PEDIDO: PedidoGoogle = {
  total: { currencyCode: 'MXN', units: '115', nanos: 840_000_000 },
};

function errorHttp(status: number): Error {
  return Object.assign(new Error('fallo con token-de-prueba en la url'), {
    status,
  });
}

function build(
  parcial: Partial<{
    [K in keyof GooglePlayApi]: jest.Mock;
  }> = {},
) {
  const api = {
    obtenerSuscripcion: jest.fn(),
    reconocer: jest.fn().mockResolvedValue(undefined),
    obtenerPedido: jest.fn().mockResolvedValue(PEDIDO),
    ...parcial,
  };
  const verificador = new VerificadorGoogle(api, () => AHORA);
  return { api, verificador };
}

const entrada = { productoId: PRODUCTO, tokenCompra: TOKEN, usuarioId: 'u-1' };

describe('VerificadorGoogle.verificar', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('ACTIVE con renovación: activa con las fechas de Google y el total del pedido', async () => {
    const h = build();
    h.api.obtenerSuscripcion.mockResolvedValue(
      suscripcion('SUBSCRIPTION_STATE_ACTIVE'),
    );
    const r = await h.verificador.verificar(entrada);
    expect(r).toEqual({
      estado: 'activa',
      orderId: 'GPA.1234',
      periodoInicio: new Date('2026-10-12T11:59:00Z'),
      periodoFin: new Date(FUTURO),
      autoRenovacion: true,
      cuentaOfuscada: 'cuenta-hmac',
      monto: 115.84,
      moneda: 'MXN',
      yaReconocida: false,
    });
    expect(h.api.obtenerPedido).toHaveBeenCalledWith('GPA.1234');
  });

  it('ACTIVE sin renovación: autoRenovacion false', async () => {
    const h = build();
    h.api.obtenerSuscripcion.mockResolvedValue(
      suscripcion('SUBSCRIPTION_STATE_ACTIVE', { autoRenew: false }),
    );
    expect((await h.verificador.verificar(entrada)).autoRenovacion).toBe(false);
  });

  it('CANCELED con expiryTime futuro: activa sin renovación', async () => {
    const h = build();
    h.api.obtenerSuscripcion.mockResolvedValue(
      suscripcion('SUBSCRIPTION_STATE_CANCELED', { autoRenew: false }),
    );
    const r = await h.verificador.verificar(entrada);
    expect(r.estado).toBe('activa');
    expect(r.autoRenovacion).toBe(false);
  });

  it('CANCELED con expiryTime pasado: rechazada', async () => {
    const h = build();
    h.api.obtenerSuscripcion.mockResolvedValue(
      suscripcion('SUBSCRIPTION_STATE_CANCELED', { expiryTime: PASADO }),
    );
    expect((await h.verificador.verificar(entrada)).estado).toBe('rechazada');
  });

  it('PENDING: pendiente sin fechas ni monto', async () => {
    const h = build();
    h.api.obtenerSuscripcion.mockResolvedValue(
      suscripcion('SUBSCRIPTION_STATE_PENDING', { orderId: null }),
    );
    const r = await h.verificador.verificar(entrada);
    expect(r).toMatchObject({
      estado: 'pendiente',
      periodoInicio: null,
      periodoFin: null,
      monto: null,
    });
    expect(h.api.obtenerPedido).not.toHaveBeenCalled();
  });

  it.each([
    'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
    'SUBSCRIPTION_STATE_ON_HOLD',
    'SUBSCRIPTION_STATE_PAUSED',
    'SUBSCRIPTION_STATE_EXPIRED',
    'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED',
    'SUBSCRIPTION_STATE_UNSPECIFIED',
  ])('%s: rechazada', async (estado) => {
    const h = build();
    h.api.obtenerSuscripcion.mockResolvedValue(suscripcion(estado));
    expect((await h.verificador.verificar(entrada)).estado).toBe('rechazada');
  });

  it('un lineItem de otro producto: rechazada', async () => {
    const h = build();
    h.api.obtenerSuscripcion.mockResolvedValue(
      suscripcion('SUBSCRIPTION_STATE_ACTIVE', { productId: 'otro' }),
    );
    expect((await h.verificador.verificar(entrada)).estado).toBe('rechazada');
  });

  it('sin obfuscatedExternalAccountId: cuentaOfuscada null', async () => {
    const h = build();
    h.api.obtenerSuscripcion.mockResolvedValue(
      suscripcion('SUBSCRIPTION_STATE_ACTIVE', { cuenta: null }),
    );
    expect((await h.verificador.verificar(entrada)).cuentaOfuscada).toBeNull();
  });

  it('testPurchase: se acepta y se registra sin el token', async () => {
    const h = build();
    h.api.obtenerSuscripcion.mockResolvedValue(
      suscripcion('SUBSCRIPTION_STATE_ACTIVE', { prueba: true }),
    );
    expect((await h.verificador.verificar(entrada)).estado).toBe('activa');
    const mensajes = log.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(
      mensajes.some((m) => m.includes('u-1') && m.includes('GPA.1234')),
    ).toBe(true);
    expect(mensajes.join(' ')).not.toContain(TOKEN);
  });

  it('ya reconocida: yaReconocida true', async () => {
    const h = build();
    h.api.obtenerSuscripcion.mockResolvedValue(
      suscripcion('SUBSCRIPTION_STATE_ACTIVE', { reconocida: true }),
    );
    expect((await h.verificador.verificar(entrada)).yaReconocida).toBe(true);
  });

  it('el pedido falla: usa recurringPrice y avisa', async () => {
    const h = build({
      obtenerPedido: jest.fn().mockRejectedValue(errorHttp(500)),
    });
    h.api.obtenerSuscripcion.mockResolvedValue(
      suscripcion('SUBSCRIPTION_STATE_ACTIVE'),
    );
    const r = await h.verificador.verificar(entrada);
    expect(r).toMatchObject({ monto: 99, moneda: 'MXN' });
    expect(warn).toHaveBeenCalled();
  });

  it('el pedido no trae total: usa recurringPrice', async () => {
    const h = build({ obtenerPedido: jest.fn().mockResolvedValue({}) });
    h.api.obtenerSuscripcion.mockResolvedValue(
      suscripcion('SUBSCRIPTION_STATE_ACTIVE'),
    );
    expect(await h.verificador.verificar(entrada)).toMatchObject({
      monto: 99,
      moneda: 'MXN',
    });
    expect(warn).toHaveBeenCalled();
  });

  it('sin pedido ni recurringPrice: monto null', async () => {
    const h = build({ obtenerPedido: jest.fn().mockResolvedValue({}) });
    const sin = suscripcion('SUBSCRIPTION_STATE_ACTIVE');
    delete sin.lineItems?.[0].autoRenewingPlan?.recurringPrice;
    h.api.obtenerSuscripcion.mockResolvedValue(sin);
    expect(await h.verificador.verificar(entrada)).toMatchObject({
      monto: null,
      moneda: null,
    });
  });

  it.each([400, 404, 410])('HTTP %i: rechazada', async (status) => {
    const h = build();
    h.api.obtenerSuscripcion.mockRejectedValue(errorHttp(status));
    expect((await h.verificador.verificar(entrada)).estado).toBe('rechazada');
  });

  it.each([401, 403, 429, 500, 503])(
    'HTTP %i: TIENDA_NO_DISPONIBLE',
    async (status) => {
      const h = build();
      h.api.obtenerSuscripcion.mockRejectedValue(errorHttp(status));
      await expect(h.verificador.verificar(entrada)).rejects.toThrow(
        new ServiceUnavailableException(MENSAJE_TIENDA_NO_DISPONIBLE),
      );
      const avisos = warn.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join(' ');
      expect(avisos).not.toContain(TOKEN);
    },
  );

  it.each(['ECONNRESET', 'ETIMEDOUT'])(
    'error de red %s: TIENDA_NO_DISPONIBLE, nunca rechazada',
    async (code) => {
      const h = build();
      h.api.obtenerSuscripcion.mockRejectedValue(
        Object.assign(new Error('red'), { code }),
      );
      await expect(h.verificador.verificar(entrada)).rejects.toThrow(
        ServiceUnavailableException,
      );
    },
  );

  it('el código HTTP puede venir en response.status o como código numérico', async () => {
    const h = build();
    h.api.obtenerSuscripcion.mockRejectedValueOnce(
      Object.assign(new Error('x'), { response: { status: 404 } }),
    );
    expect((await h.verificador.verificar(entrada)).estado).toBe('rechazada');
    h.api.obtenerSuscripcion.mockRejectedValueOnce(
      Object.assign(new Error('x'), { code: 410 }),
    );
    expect((await h.verificador.verificar(entrada)).estado).toBe('rechazada');
  });
});

describe('VerificadorGoogle.reconocer', () => {
  it('llama a acknowledge con producto y token', async () => {
    const h = build();
    await h.verificador.reconocer(entrada);
    expect(h.api.reconocer).toHaveBeenCalledWith(PRODUCTO, TOKEN);
  });

  it('"ya reconocida" cuenta como éxito', async () => {
    const h = build({ reconocer: jest.fn().mockRejectedValue(errorHttp(400)) });
    h.api.obtenerSuscripcion.mockResolvedValue(
      suscripcion('SUBSCRIPTION_STATE_ACTIVE', { reconocida: true }),
    );
    await expect(h.verificador.reconocer(entrada)).resolves.toBeUndefined();
  });

  it('un 400 sin reconocimiento previo es un error (sin el token)', async () => {
    const h = build({ reconocer: jest.fn().mockRejectedValue(errorHttp(400)) });
    h.api.obtenerSuscripcion.mockResolvedValue(
      suscripcion('SUBSCRIPTION_STATE_ACTIVE'),
    );
    const falla = h.verificador.reconocer(entrada);
    await expect(falla).rejects.toThrow('http 400');
    await expect(falla).rejects.not.toThrow(TOKEN);
  });

  it('un 500 es un error', async () => {
    const h = build({ reconocer: jest.fn().mockRejectedValue(errorHttp(500)) });
    await expect(h.verificador.reconocer(entrada)).rejects.toThrow('http 500');
    expect(h.api.obtenerSuscripcion).not.toHaveBeenCalled();
  });
});

describe('dineroANumero', () => {
  it('convierte units + nanos a 2 decimales', () => {
    expect(dineroANumero({ units: '99', nanos: 0 })).toBe(99);
    expect(dineroANumero({ units: '12', nanos: 345_000_000 })).toBe(12.35);
    expect(dineroANumero({ nanos: 500_000_000 })).toBe(0.5);
  });

  it('vacío o no numérico: null', () => {
    expect(dineroANumero({})).toBeNull();
    expect(dineroANumero({ units: 'abc' })).toBeNull();
  });
});
