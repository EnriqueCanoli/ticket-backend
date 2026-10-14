import { FuenteEstadoSimulada } from './fuente-estado-google';
import {
  decodificarMensaje,
  huellaToken,
  nombreTipoSuscripcion,
  sanitizarPayload,
} from './rtdn.types';

const b64 = (objeto: unknown) =>
  Buffer.from(JSON.stringify(objeto)).toString('base64');

describe('decodificarMensaje', () => {
  it.each([
    [1, 'SUBSCRIPTION_RECOVERED'],
    [2, 'SUBSCRIPTION_RENEWED'],
    [3, 'SUBSCRIPTION_CANCELED'],
    [4, 'SUBSCRIPTION_PURCHASED'],
    [5, 'SUBSCRIPTION_ON_HOLD'],
    [6, 'SUBSCRIPTION_IN_GRACE_PERIOD'],
    [7, 'SUBSCRIPTION_RESTARTED'],
    [12, 'SUBSCRIPTION_REVOKED'],
    [13, 'SUBSCRIPTION_EXPIRED'],
    [20, 'SUBSCRIPTION_PENDING_PURCHASE_CANCELED'],
    [22, 'SUBSCRIPTION_PRICE_STEP_UP_CONSENT_UPDATED'],
  ])('notificationType %d → %s', (numero, nombre) => {
    expect(nombreTipoSuscripcion(numero)).toBe(nombre);
    const d = decodificarMensaje(
      b64({
        packageName: 'com.x',
        subscriptionNotification: {
          version: '1.0',
          notificationType: numero,
          purchaseToken: 'tok-secreto',
        },
      }),
    );
    expect(d?.mensaje).toMatchObject({
      clase: 'suscripcion',
      tipo: nombre,
      token: 'tok-secreto',
      ignorado: false,
    });
  });

  it('PAUSE_SCHEDULE_CHANGED y tipos desconocidos se marcan como ignorados', () => {
    for (const n of [11, 99]) {
      const d = decodificarMensaje(
        b64({
          subscriptionNotification: { notificationType: n, purchaseToken: 't' },
        }),
      );
      expect(d?.mensaje).toMatchObject({
        clase: 'suscripcion',
        ignorado: true,
      });
    }
  });

  it('voided, prueba, un solo pago y revisión de reembolso', () => {
    expect(
      decodificarMensaje(
        b64({
          voidedPurchaseNotification: {
            purchaseToken: 't',
            orderId: 'GPA.1',
            productType: 1,
            refundType: 1,
          },
        }),
      )?.mensaje,
    ).toMatchObject({
      clase: 'voided',
      tipo: 'VOIDED_PURCHASE',
      orderId: 'GPA.1',
      productType: 1,
      refundType: 1,
    });
    expect(
      decodificarMensaje(b64({ testNotification: { version: '1.0' } }))
        ?.mensaje,
    ).toEqual({ clase: 'prueba', tipo: 'TEST' });
    expect(
      decodificarMensaje(
        b64({ oneTimeProductNotification: { purchaseToken: 't' } }),
      )?.mensaje,
    ).toEqual({ clase: 'otro', tipo: 'ONE_TIME_PRODUCT' });
    expect(
      decodificarMensaje(b64({ pendingRefundReviewNotification: { a: 1 } }))
        ?.mensaje,
    ).toEqual({ clase: 'otro', tipo: 'PENDING_REFUND_REVIEW' });
    expect(decodificarMensaje(b64({ otraCosa: 1 }))?.mensaje).toEqual({
      clase: 'otro',
      tipo: 'DESCONOCIDO',
    });
  });

  it('el payload guardado nunca contiene el token (F8)', () => {
    const d = decodificarMensaje(
      b64({
        subscriptionNotification: {
          notificationType: 2,
          purchaseToken: 'tok-secreto',
        },
      }),
    );
    const texto = JSON.stringify(d?.payload);
    expect(texto).not.toContain('tok-secreto');
    expect(texto).toContain(huellaToken('tok-secreto'));
    expect(huellaToken('tok-secreto')).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(
      JSON.stringify(sanitizarPayload({ a: [{ linkedPurchaseToken: 'x' }] })),
    ).not.toContain('"x"');
  });

  it('data inválida: null', () => {
    expect(decodificarMensaje(undefined)).toBeNull();
    expect(decodificarMensaje('')).toBeNull();
    expect(decodificarMensaje('%%%no-es-base64-ni-json')).toBeNull();
    expect(decodificarMensaje(b64('texto'))).toBeNull();
    expect(decodificarMensaje(b64([1, 2]))).toBeNull();
  });
});

describe('FuenteEstadoSimulada', () => {
  const AHORA = new Date('2026-03-14T18:00:00Z');
  const fuente = new FuenteEstadoSimulada(() => AHORA);
  const compra = (periodoFin: string, orderId = 'SIM-abc') => ({
    estado: 'confirmada',
    orderId,
    periodoFin: new Date(periodoFin),
  });
  const consulta = (tipo: number | null, c = compra('2026-04-14T18:00:00Z')) =>
    fuente.obtener({
      token: 'mock-compra-1',
      productoId: 'ticket_mensual',
      tipoNotificacion: tipo,
      compra: c,
    });

  it('RENEWED: ACTIVE, pedido nuevo determinista y un mes más', async () => {
    const g = await consulta(2);
    expect(g.subscriptionState).toBe('SUBSCRIPTION_STATE_ACTIVE');
    expect(g.lineItems?.[0].expiryTime).toBe('2026-05-14T18:00:00.000Z');
    expect(g.lineItems?.[0].latestSuccessfulOrderId).toMatch(
      /^SIM-[0-9a-f]{24}-R1$/,
    );
    const siguiente = await consulta(
      2,
      compra('2026-05-14T18:00:00Z', 'SIM-abc-R1'),
    );
    expect(siguiente.lineItems?.[0].latestSuccessfulOrderId).toMatch(/-R2$/);
  });

  it('con periodo_fin pasado suma un mes a partir de ahora', async () => {
    const g = await consulta(2, compra('2026-01-01T00:00:00Z'));
    expect(g.lineItems?.[0].expiryTime).toBe('2026-04-14T18:00:00.000Z');
  });

  it('RESTARTED conserva periodo_fin', async () => {
    const g = await consulta(7);
    expect(g.lineItems?.[0].expiryTime).toBe('2026-04-14T18:00:00.000Z');
  });

  it('CANCELED: expiry = periodo_fin y sin renovación', async () => {
    const g = await consulta(3);
    expect(g.subscriptionState).toBe('SUBSCRIPTION_STATE_CANCELED');
    expect(g.lineItems?.[0].autoRenewingPlan?.autoRenewEnabled).toBe(false);
    expect(g.lineItems?.[0].expiryTime).toBe('2026-04-14T18:00:00.000Z');
  });

  it('ON_HOLD e IN_GRACE_PERIOD: ON_HOLD con expiry en el pasado', async () => {
    for (const n of [5, 6]) {
      const g = await consulta(n);
      expect(g.subscriptionState).toBe('SUBSCRIPTION_STATE_ON_HOLD');
      expect(
        new Date(g.lineItems?.[0].expiryTime as string).getTime(),
      ).toBeLessThan(AHORA.getTime());
    }
  });

  it('EXPIRED y REVOKED: EXPIRED', async () => {
    for (const n of [12, 13]) {
      expect((await consulta(n)).subscriptionState).toBe(
        'SUBSCRIPTION_STATE_EXPIRED',
      );
    }
  });

  it('monto simulado 99 MXN', async () => {
    const g = await consulta(2);
    expect(g.lineItems?.[0].autoRenewingPlan?.recurringPrice).toEqual({
      currencyCode: 'MXN',
      units: '99',
      nanos: 0,
    });
  });

  it('un token ajeno sin compra guardada responde 404', async () => {
    await expect(
      fuente.obtener({
        token: 'otro-token',
        productoId: 'p',
        tipoNotificacion: 2,
        compra: null,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
