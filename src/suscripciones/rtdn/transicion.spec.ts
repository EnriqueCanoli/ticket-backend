import { transicionDesdeGoogle } from './transicion';
import type {
  CompraTransicion,
  ContextoTransicion,
  FilaTransicion,
  PlanTransicion,
} from './transicion';
import type { SuscripcionGoogle } from '../verificadores/google-play-api';

const PRODUCTO = 'ticket_mensual';
const COMPRA_ID = '11111111-1111-1111-1111-111111111111';
const d = (iso: string) => new Date(iso);

function google(
  estado: string,
  expiry: string,
  orderId: string,
  extra: Partial<SuscripcionGoogle> = {},
  autoRenew = true,
): SuscripcionGoogle {
  return {
    subscriptionState: `SUBSCRIPTION_STATE_${estado}`,
    lineItems: [
      {
        productId: PRODUCTO,
        expiryTime: expiry,
        latestSuccessfulOrderId: orderId,
        autoRenewingPlan: {
          autoRenewEnabled: autoRenew,
          recurringPrice: { currencyCode: 'MXN', units: '99', nanos: 0 },
        },
      },
    ],
    ...extra,
  };
}

function contexto(
  parcial: Partial<ContextoTransicion> = {},
): ContextoTransicion {
  return {
    productoId: PRODUCTO,
    pedidoRegistrado: false,
    pedido: null,
    eventoEn: null,
    orderIdReembolso: null,
    ...parcial,
  };
}

function filaActiva(): FilaTransicion {
  return {
    estado: 'activa',
    motivo: null,
    accesoHasta: d('2026-04-14T12:00:00Z'),
    proximoCobro: d('2026-04-14T12:00:00Z'),
    renovacionAutomatica: true,
    tienda: 'google_play',
  };
}

function compraConfirmada(): CompraTransicion {
  return {
    id: COMPRA_ID,
    estado: 'confirmada',
    orderId: 'GPA.1',
    periodoFin: d('2026-04-14T12:00:00Z'),
  };
}

/** Aplica un plan a copias de la fila y la compra (lo que hace el ejecutor). */
function aplicar(
  fila: FilaTransicion,
  compra: CompraTransicion,
  plan: PlanTransicion,
): { fila: FilaTransicion; compra: CompraTransicion } {
  return {
    fila: { ...fila, ...plan.suscripcion },
    compra: { ...compra, ...plan.compra },
  };
}

const bloqueadaPorCobro = (): FilaTransicion => ({
  ...filaActiva(),
  estado: 'vencida',
  motivo: 'cobro_fallido',
  renovacionAutomatica: false,
  proximoCobro: null,
});

describe('transicionDesdeGoogle', () => {
  it('pago del 14 de marzo (ACTIVE): activa, compra confirmada y pago con el monto del pedido', () => {
    const fila: FilaTransicion = {
      estado: 'prueba',
      motivo: null,
      accesoHasta: null,
      proximoCobro: null,
      renovacionAutomatica: false,
      tienda: null,
    };
    const compra: CompraTransicion = {
      id: COMPRA_ID,
      estado: 'pendiente',
      orderId: null,
      periodoFin: null,
    };
    const plan = transicionDesdeGoogle(
      fila,
      compra,
      google('ACTIVE', '2026-04-14T18:00:00Z', 'GPA.1'),
      'SUBSCRIPTION_PURCHASED',
      d('2026-03-14T18:00:00Z'),
      false,
      contexto({
        pedido: {
          monto: 129.5,
          moneda: 'MXN',
          creadoEn: d('2026-03-14T18:00:00Z'),
        },
      }),
    );
    expect(plan.resultado).toBe('aplicado');
    expect(plan.suscripcion).toMatchObject({
      estado: 'activa',
      renovacionAutomatica: true,
      accesoHasta: d('2026-04-14T18:00:00Z'),
      proximoCobro: d('2026-04-14T18:00:00Z'),
      tienda: 'google_play',
    });
    expect(plan.compra).toMatchObject({
      estado: 'confirmada',
      orderId: 'GPA.1',
    });
    expect(plan.pagos).toEqual([
      expect.objectContaining({
        externalId: 'GPA.1',
        periodo: '2026-03',
        monto: 129.5,
        estado: 'pagado',
      }),
    ]);
  });

  it('un pago sin total del pedido usa el precio recurrente y avisa', () => {
    const plan = transicionDesdeGoogle(
      filaActiva(),
      compraConfirmada(),
      google('ACTIVE', '2026-05-14T12:00:00Z', 'GPA.2'),
      'SUBSCRIPTION_RENEWED',
      d('2026-04-14T12:00:00Z'),
      false,
      contexto({ eventoEn: d('2026-04-14T12:00:10Z') }),
    );
    expect(plan.pagos[0]).toMatchObject({
      monto: 99,
      moneda: 'MXN',
      periodo: '2026-04',
    });
    expect(plan.pagos[0].cobradoEn).toEqual(d('2026-04-14T12:00:10Z'));
    expect(plan.avisos).toHaveLength(1);
  });

  it('una renovación mueve acceso_hasta y no toca estado (estado_desde no cambia)', () => {
    const plan = transicionDesdeGoogle(
      filaActiva(),
      compraConfirmada(),
      google('ACTIVE', '2026-05-14T12:00:00Z', 'GPA.2'),
      'SUBSCRIPTION_RENEWED',
      d('2026-04-14T12:00:00Z'),
      false,
      contexto(),
    );
    expect(plan.suscripcion.estado).toBeUndefined();
    expect(plan.suscripcion.accesoHasta).toEqual(d('2026-05-14T12:00:00Z'));
    expect(plan.pagos).toHaveLength(1);
  });

  it('el mismo estado otra vez (pedido ya registrado) es sin_cambios', () => {
    const plan = transicionDesdeGoogle(
      filaActiva(),
      compraConfirmada(),
      google('ACTIVE', '2026-04-14T12:00:00Z', 'GPA.1'),
      'SUBSCRIPTION_RENEWED',
      d('2026-03-20T12:00:00Z'),
      false,
      contexto({ pedidoRegistrado: true }),
    );
    expect(plan.resultado).toBe('sin_cambios');
  });

  describe('cobro fallido el 14 de abril y recuperación el 17 (F1, F2)', () => {
    it('ON_HOLD: vencida/cobro_fallido y fila fallido con el id de la compra', () => {
      const plan = transicionDesdeGoogle(
        filaActiva(),
        compraConfirmada(),
        google('ON_HOLD', '2026-04-14T12:00:00Z', 'GPA.1', {}, false),
        'SUBSCRIPTION_ON_HOLD',
        d('2026-04-14T13:00:00Z'),
        false,
        contexto({ pedidoRegistrado: true }),
      );
      expect(plan.suscripcion).toMatchObject({
        estado: 'vencida',
        motivo: 'cobro_fallido',
        renovacionAutomatica: false,
        proximoCobro: null,
      });
      expect(plan.suscripcion.accesoHasta).toBeUndefined();
      expect(plan.pagos).toEqual([
        expect.objectContaining({
          externalId: `fallido-${COMPRA_ID}-2026-04`,
          periodo: '2026-04',
          cobradoEn: d('2026-04-14T12:00:00Z'),
          monto: 99,
          estado: 'fallido',
        }),
      ]);
    });

    it('IN_GRACE_PERIOD se trata igual que ON_HOLD', () => {
      const plan = transicionDesdeGoogle(
        filaActiva(),
        compraConfirmada(),
        google('IN_GRACE_PERIOD', '2026-04-15T12:00:00Z', 'GPA.1'),
        'SUBSCRIPTION_IN_GRACE_PERIOD',
        d('2026-04-14T13:00:00Z'),
        false,
        contexto({ pedidoRegistrado: true }),
      );
      expect(plan.suscripcion.estado).toBe('vencida');
      expect(plan.suscripcion.motivo).toBe('cobro_fallido');
    });

    it('un segundo aviso ON_HOLD con la cuenta ya bloqueada no cambia nada', () => {
      const plan = transicionDesdeGoogle(
        bloqueadaPorCobro(),
        compraConfirmada(),
        google('ON_HOLD', '2026-04-14T12:00:00Z', 'GPA.1', {}, false),
        'SUBSCRIPTION_ON_HOLD',
        d('2026-04-15T13:00:00Z'),
        false,
        contexto({ pedidoRegistrado: true }),
      );
      expect(plan.resultado).toBe('sin_cambios');
    });

    it('RECOVERED el 17: activa de nuevo y pago pagado; la fila fallido no se toca', () => {
      const plan = transicionDesdeGoogle(
        bloqueadaPorCobro(),
        compraConfirmada(),
        google('ACTIVE', '2026-05-14T12:00:00Z', 'GPA.2'),
        'SUBSCRIPTION_RECOVERED',
        d('2026-04-17T15:00:00Z'),
        false,
        contexto({
          pedido: {
            monto: 99,
            moneda: 'MXN',
            creadoEn: d('2026-04-17T15:00:00Z'),
          },
        }),
      );
      expect(plan.suscripcion).toMatchObject({
        estado: 'activa',
        motivo: null,
        renovacionAutomatica: true,
        accesoHasta: d('2026-05-14T12:00:00Z'),
      });
      expect(plan.pagos).toHaveLength(1);
      expect(plan.pagos[0]).toMatchObject({
        externalId: 'GPA.2',
        periodo: '2026-04',
        estado: 'pagado',
      });
      expect(plan.reembolsarPago).toBeNull();
    });
  });

  describe('cancelación del 20 de marzo con acceso hasta el 14 de abril (F4)', () => {
    it('CANCELED con expiry futuro: cancelada hasta el expiry', () => {
      const plan = transicionDesdeGoogle(
        filaActiva(),
        compraConfirmada(),
        google('CANCELED', '2026-04-14T12:00:00Z', 'GPA.1', {}, false),
        'SUBSCRIPTION_CANCELED',
        d('2026-03-20T12:00:00Z'),
        false,
        contexto({ pedidoRegistrado: true }),
      );
      expect(plan.suscripcion).toMatchObject({
        estado: 'cancelada',
        renovacionAutomatica: false,
        proximoCobro: null,
      });
      // acceso_hasta y motivo ya valían lo mismo: el plan solo trae diferencias.
      expect(plan.suscripcion.accesoHasta).toBeUndefined();
    });

    it('RESTARTED antes del vencimiento: vuelve a activa sin pago nuevo', () => {
      const cancelada: FilaTransicion = {
        ...filaActiva(),
        estado: 'cancelada',
        renovacionAutomatica: false,
        proximoCobro: null,
      };
      const plan = transicionDesdeGoogle(
        cancelada,
        compraConfirmada(),
        google('ACTIVE', '2026-04-14T12:00:00Z', 'GPA.1'),
        'SUBSCRIPTION_RESTARTED',
        d('2026-03-25T12:00:00Z'),
        false,
        contexto({ pedidoRegistrado: true }),
      );
      expect(plan.suscripcion).toMatchObject({
        estado: 'activa',
        renovacionAutomatica: true,
        proximoCobro: d('2026-04-14T12:00:00Z'),
      });
      expect(plan.pagos).toEqual([]);
    });

    it('EXPIRED tras cancelar: vencida/cancelada y compra expirada', () => {
      const cancelada: FilaTransicion = {
        ...filaActiva(),
        estado: 'cancelada',
        renovacionAutomatica: false,
        proximoCobro: null,
      };
      const plan = transicionDesdeGoogle(
        cancelada,
        compraConfirmada(),
        google('EXPIRED', '2026-04-14T12:00:00Z', 'GPA.1', {}, false),
        'SUBSCRIPTION_EXPIRED',
        d('2026-04-14T12:05:00Z'),
        false,
        contexto({ pedidoRegistrado: true }),
      );
      expect(plan.suscripcion).toMatchObject({
        estado: 'vencida',
        motivo: 'cancelada',
      });
      expect(plan.compra.estado).toBe('expirada');
    });

    it('CANCELED con expiry pasado se trata como EXPIRED', () => {
      const plan = transicionDesdeGoogle(
        filaActiva(),
        compraConfirmada(),
        google('CANCELED', '2026-04-14T12:00:00Z', 'GPA.1', {}, false),
        'SUBSCRIPTION_CANCELED',
        d('2026-04-20T12:00:00Z'),
        false,
        contexto({ pedidoRegistrado: true }),
      );
      expect(plan.suscripcion.estado).toBe('vencida');
      expect(plan.compra.estado).toBe('expirada');
    });
  });

  describe('EXPIRED: motivo', () => {
    it('desde vencida/cobro_fallido conserva cobro_fallido', () => {
      const plan = transicionDesdeGoogle(
        bloqueadaPorCobro(),
        compraConfirmada(),
        google('EXPIRED', '2026-04-14T12:00:00Z', 'GPA.1', {}, false),
        'SUBSCRIPTION_EXPIRED',
        d('2026-05-14T12:00:00Z'),
        false,
        contexto({ pedidoRegistrado: true }),
      );
      expect(plan.suscripcion.motivo).toBeUndefined(); // ya era cobro_fallido
      expect(plan.compra.estado).toBe('expirada');
    });

    it('con systemInitiatedCancellation el motivo es cobro_fallido', () => {
      const plan = transicionDesdeGoogle(
        filaActiva(),
        compraConfirmada(),
        google('EXPIRED', '2026-04-14T12:00:00Z', 'GPA.1', {
          canceledStateContext: { systemInitiatedCancellation: {} },
        }),
        'SUBSCRIPTION_EXPIRED',
        d('2026-04-20T12:00:00Z'),
        false,
        contexto({ pedidoRegistrado: true }),
      );
      expect(plan.suscripcion).toMatchObject({
        estado: 'vencida',
        motivo: 'cobro_fallido',
      });
    });

    it('replacementCancellation: solo expira la compra, la cuenta no se toca', () => {
      const plan = transicionDesdeGoogle(
        filaActiva(),
        compraConfirmada(),
        google('EXPIRED', '2026-04-14T12:00:00Z', 'GPA.1', {
          canceledStateContext: { replacementCancellation: {} },
        }),
        'SUBSCRIPTION_EXPIRED',
        d('2026-04-20T12:00:00Z'),
        false,
        contexto({ pedidoRegistrado: true }),
      );
      expect(plan.suscripcion).toEqual({});
      expect(plan.compra.estado).toBe('expirada');
    });
  });

  describe('reembolso (F3)', () => {
    const reembolsada: FilaTransicion = {
      ...filaActiva(),
      estado: 'vencida',
      motivo: 'reembolso',
      renovacionAutomatica: false,
      proximoCobro: null,
    };
    const compraReembolsada: CompraTransicion = {
      ...compraConfirmada(),
      estado: 'reembolsada',
    };

    it('voided con Google ACTIVE: vencida/reembolso, compra reembolsada y pago reembolsado', () => {
      const plan = transicionDesdeGoogle(
        filaActiva(),
        compraConfirmada(),
        google('ACTIVE', '2026-04-14T12:00:00Z', 'GPA.1'),
        'VOIDED_PURCHASE',
        d('2026-03-16T12:00:00Z'),
        false,
        contexto({ pedidoRegistrado: true, orderIdReembolso: 'GPA.1' }),
      );
      expect(plan.suscripcion).toMatchObject({
        estado: 'vencida',
        motivo: 'reembolso',
        renovacionAutomatica: false,
        proximoCobro: null,
      });
      expect(plan.compra.estado).toBe('reembolsada');
      expect(plan.reembolsarPago).toBe('GPA.1');
    });

    it('REVOKED (Google EXPIRED) reembolsa el último pedido', () => {
      const plan = transicionDesdeGoogle(
        filaActiva(),
        compraConfirmada(),
        google('EXPIRED', '2026-03-16T12:00:00Z', 'GPA.1', {}, false),
        'SUBSCRIPTION_REVOKED',
        d('2026-03-16T12:00:00Z'),
        false,
        contexto({ pedidoRegistrado: true, orderIdReembolso: 'GPA.1' }),
      );
      expect(plan.suscripcion.motivo).toBe('reembolso');
      expect(plan.compra.estado).toBe('reembolsada');
      expect(plan.reembolsarPago).toBe('GPA.1');
    });

    it('un aviso posterior sin pedido nuevo sigue en reembolso', () => {
      for (const [estado, tipo] of [
        ['ACTIVE', 'SUBSCRIPTION_RENEWED'],
        ['ON_HOLD', 'SUBSCRIPTION_ON_HOLD'],
        ['CANCELED', 'SUBSCRIPTION_CANCELED'],
      ] as const) {
        const plan = transicionDesdeGoogle(
          reembolsada,
          compraReembolsada,
          google(estado, '2026-04-14T12:00:00Z', 'GPA.1'),
          tipo,
          d('2026-03-20T12:00:00Z'),
          false,
          contexto({ pedidoRegistrado: true }),
        );
        expect(plan.suscripcion).toEqual({});
        expect(plan.resultado).toBe('sin_cambios');
      }
    });

    it('un pedido NUEVO pagado con ACTIVE reactiva la cuenta', () => {
      const plan = transicionDesdeGoogle(
        reembolsada,
        compraReembolsada,
        google('ACTIVE', '2026-05-14T12:00:00Z', 'GPA.2'),
        'SUBSCRIPTION_RENEWED',
        d('2026-04-14T12:00:00Z'),
        false,
        contexto({
          pedido: {
            monto: 99,
            moneda: 'MXN',
            creadoEn: d('2026-04-14T12:00:00Z'),
          },
        }),
      );
      expect(plan.suscripcion).toMatchObject({
        estado: 'activa',
        motivo: null,
      });
      expect(plan.compra.estado).toBe('confirmada');
      expect(plan.pagos).toHaveLength(1);
    });

    it('con otraCompraVigente, el reembolso de la compra vieja no toca la cuenta (F7)', () => {
      const plan = transicionDesdeGoogle(
        filaActiva(),
        compraConfirmada(),
        google('ACTIVE', '2026-04-14T12:00:00Z', 'GPA.1'),
        'VOIDED_PURCHASE',
        d('2026-03-16T12:00:00Z'),
        true,
        contexto({ pedidoRegistrado: true, orderIdReembolso: 'GPA.1' }),
      );
      expect(plan.suscripcion).toEqual({});
      expect(plan.compra.estado).toBe('reembolsada');
      expect(plan.reembolsarPago).toBe('GPA.1');
    });
  });

  it('otraCompraVigente: ON_HOLD, EXPIRED y PAUSED de la compra vieja no tocan la cuenta ni anotan fallidos (F7)', () => {
    for (const [estado, tipo] of [
      ['ON_HOLD', 'SUBSCRIPTION_ON_HOLD'],
      ['EXPIRED', 'SUBSCRIPTION_EXPIRED'],
      ['PAUSED', 'SUBSCRIPTION_PAUSED'],
    ] as const) {
      const plan = transicionDesdeGoogle(
        filaActiva(),
        compraConfirmada(),
        google(estado, '2026-04-14T12:00:00Z', 'GPA.1'),
        tipo,
        d('2026-04-15T12:00:00Z'),
        true,
        contexto({ pedidoRegistrado: true }),
      );
      expect(plan.suscripcion).toEqual({});
      expect(plan.pagos).toEqual([]);
    }
  });

  it('PAUSED sin otra compra: vencida/cancelada', () => {
    const plan = transicionDesdeGoogle(
      filaActiva(),
      compraConfirmada(),
      google('PAUSED', '2026-04-14T12:00:00Z', 'GPA.1'),
      'SUBSCRIPTION_PAUSED',
      d('2026-04-01T12:00:00Z'),
      false,
      contexto({ pedidoRegistrado: true }),
    );
    expect(plan.suscripcion).toMatchObject({
      estado: 'vencida',
      motivo: 'cancelada',
    });
  });

  it('PENDING de una compra pendiente se delega; PENDING_PURCHASE_CANCELED de una confirmada se ignora', () => {
    const pendiente: CompraTransicion = {
      ...compraConfirmada(),
      estado: 'pendiente',
    };
    expect(
      transicionDesdeGoogle(
        filaActiva(),
        pendiente,
        google('PENDING', '2026-04-14T12:00:00Z', 'GPA.1'),
        'SUBSCRIPTION_PURCHASED',
        d('2026-03-14T12:00:00Z'),
        false,
        contexto(),
      ).resultado,
    ).toBe('delegar_pendiente');
    expect(
      transicionDesdeGoogle(
        filaActiva(),
        compraConfirmada(),
        google('PENDING_PURCHASE_CANCELED', '2026-04-14T12:00:00Z', 'GPA.1'),
        'SUBSCRIPTION_PENDING_PURCHASE_CANCELED',
        d('2026-03-14T12:00:00Z'),
        false,
        contexto(),
      ).resultado,
    ).toBe('ignorado');
  });

  it('UNSPECIFIED o sin lineItem del producto: ignorado', () => {
    expect(
      transicionDesdeGoogle(
        filaActiva(),
        compraConfirmada(),
        google('UNSPECIFIED', '2026-04-14T12:00:00Z', 'GPA.1'),
        'SUBSCRIPTION_RENEWED',
        d('2026-03-14T12:00:00Z'),
        false,
        contexto(),
      ).resultado,
    ).toBe('ignorado');
    expect(
      transicionDesdeGoogle(
        filaActiva(),
        compraConfirmada(),
        { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', lineItems: [] },
        'SUBSCRIPTION_RENEWED',
        d('2026-03-14T12:00:00Z'),
        false,
        contexto(),
      ).resultado,
    ).toBe('ignorado');
  });

  it('secuencia: cancelar, reactivar, fallo y recuperación', () => {
    let fila: FilaTransicion = filaActiva();
    let compra: CompraTransicion = compraConfirmada();
    const paso = (
      g: SuscripcionGoogle,
      tipo: string,
      ahora: string,
      ctx: Partial<ContextoTransicion> = {},
    ) => {
      const plan = transicionDesdeGoogle(
        fila,
        compra,
        g,
        tipo,
        d(ahora),
        false,
        contexto({ pedidoRegistrado: true, ...ctx }),
      );
      ({ fila, compra } = aplicar(fila, compra, plan));
      return plan;
    };
    paso(
      google('CANCELED', '2026-04-14T12:00:00Z', 'GPA.1', {}, false),
      'SUBSCRIPTION_CANCELED',
      '2026-03-20T12:00:00Z',
    );
    expect(fila.estado).toBe('cancelada');
    paso(
      google('ACTIVE', '2026-04-14T12:00:00Z', 'GPA.1'),
      'SUBSCRIPTION_RESTARTED',
      '2026-03-25T12:00:00Z',
    );
    expect(fila.estado).toBe('activa');
    const fallo = paso(
      google('ON_HOLD', '2026-04-14T12:00:00Z', 'GPA.1', {}, false),
      'SUBSCRIPTION_ON_HOLD',
      '2026-04-14T13:00:00Z',
    );
    expect(fila.motivo).toBe('cobro_fallido');
    expect(fallo.pagos[0].estado).toBe('fallido');
    const rec = paso(
      google('ACTIVE', '2026-05-14T12:00:00Z', 'GPA.2'),
      'SUBSCRIPTION_RECOVERED',
      '2026-04-17T15:00:00Z',
      { pedidoRegistrado: false },
    );
    expect(fila.estado).toBe('activa');
    expect(rec.pagos[0].estado).toBe('pagado');
    expect(compra.orderId).toBe('GPA.2');
  });
});
