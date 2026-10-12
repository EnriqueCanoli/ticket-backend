import { ForbiddenException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { Suscripcion } from './entities/suscripcion.entity';
import { PagoHistorial } from './entities/pago-historial.entity';
import { MAX_HISTORIAL, SuscripcionesService } from './suscripciones.service';

/**
 * Specs unitarios sin base de datos: el repositorio se mockea y el service se
 * construye directamente, igual que en auth.service.spec.ts.
 */

const CLAVES_SNAPSHOT = [
  'acceso_hasta',
  'ahora_servidor',
  'estado',
  'historial',
  'motivo',
  'prueba_fin',
  'prueba_inicio',
  'proximo_cobro',
  'renovacion_automatica',
  'tienda',
];

const ISO_NEGOCIO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-06:00$/;

function buildFila(overrides: Partial<Suscripcion> = {}): Suscripcion {
  return {
    id: 'sus-1',
    usuarioId: 'user-1',
    estado: 'prueba',
    pruebaInicio: new Date('2026-03-03T09:12:00-06:00'),
    pruebaFin: new Date('2026-03-16T23:59:59-06:00'),
    accesoHasta: null,
    proximoCobro: null,
    renovacionAutomatica: false,
    tienda: null,
    motivo: null,
    estadoDesde: new Date('2026-03-03T09:12:00-06:00'),
    createdAt: new Date('2026-03-03T09:12:00-06:00'),
    updatedAt: new Date('2026-03-03T09:12:00-06:00'),
    ...overrides,
  } as Suscripcion;
}

function buildService() {
  const manager = { query: jest.fn().mockResolvedValue([]) };
  const suscripcionRepository = { findOne: jest.fn(), manager };
  const pagoHistorialRepository = { find: jest.fn().mockResolvedValue([]) };
  const service = new SuscripcionesService(
    suscripcionRepository as unknown as Repository<Suscripcion>,
    pagoHistorialRepository as unknown as Repository<PagoHistorial>,
  );
  return { service, suscripcionRepository, pagoHistorialRepository, manager };
}

const USUARIO = {
  id: 'user-1',
  createdAt: new Date('2026-03-03T09:12:00-06:00'),
};

describe('SuscripcionesService.snapshot', () => {
  it('prueba vigente', async () => {
    const { service, suscripcionRepository } = buildService();
    suscripcionRepository.findOne.mockResolvedValue(buildFila());

    const snap = await service.snapshot(
      USUARIO,
      new Date('2026-03-10T10:00:00-06:00'),
    );

    expect(snap).toEqual({
      estado: 'prueba',
      prueba_inicio: '2026-03-03T09:12:00-06:00',
      prueba_fin: '2026-03-16T23:59:59-06:00',
      acceso_hasta: null,
      proximo_cobro: null,
      renovacion_automatica: false,
      tienda: null,
      motivo: null,
      ahora_servidor: '2026-03-10T10:00:00-06:00',
      historial: [],
    });
  });

  it('prueba vencida: estado efectivo prueba_vencida con motivo prueba_terminada', async () => {
    const { service, suscripcionRepository } = buildService();
    suscripcionRepository.findOne.mockResolvedValue(buildFila());

    const snap = await service.snapshot(
      USUARIO,
      new Date('2026-03-17T00:05:00-06:00'),
    );

    expect(snap.estado).toBe('prueba_vencida');
    expect(snap.motivo).toBe('prueba_terminada');
    expect(snap.proximo_cobro).toBeNull();
    expect(snap.renovacion_automatica).toBe(false);
  });

  it('activa con renovación: expone proximo_cobro, acceso_hasta y tienda', async () => {
    const { service, suscripcionRepository } = buildService();
    suscripcionRepository.findOne.mockResolvedValue(
      buildFila({
        estado: 'activa',
        accesoHasta: new Date('2026-04-14T14:05:00-06:00'),
        proximoCobro: new Date('2026-04-14T14:05:00-06:00'),
        renovacionAutomatica: true,
        tienda: 'google_play',
      }),
    );

    const snap = await service.snapshot(
      USUARIO,
      new Date('2026-03-20T08:00:00-06:00'),
    );

    expect(snap).toMatchObject({
      estado: 'activa',
      prueba_fin: '2026-03-16T23:59:59-06:00',
      acceso_hasta: '2026-04-14T14:05:00-06:00',
      proximo_cobro: '2026-04-14T14:05:00-06:00',
      renovacion_automatica: true,
      tienda: 'google_play',
      motivo: null,
    });
  });

  it('cancelada vigente: sin proximo_cobro ni renovación; vencida: motivo cancelada', async () => {
    const { service, suscripcionRepository } = buildService();
    suscripcionRepository.findOne.mockResolvedValue(
      buildFila({
        estado: 'cancelada',
        accesoHasta: new Date('2026-04-14T14:05:00-06:00'),
        proximoCobro: new Date('2026-04-14T14:05:00-06:00'),
        renovacionAutomatica: true,
        tienda: 'google_play',
      }),
    );

    const vigente = await service.snapshot(
      USUARIO,
      new Date('2026-04-01T09:00:00-06:00'),
    );
    expect(vigente.estado).toBe('cancelada');
    expect(vigente.proximo_cobro).toBeNull();
    expect(vigente.renovacion_automatica).toBe(false);
    expect(vigente.motivo).toBeNull();
    expect(vigente.acceso_hasta).toBe('2026-04-14T14:05:00-06:00');

    const vencida = await service.snapshot(
      USUARIO,
      new Date('2026-04-15T09:00:00-06:00'),
    );
    expect(vencida.estado).toBe('vencida');
    expect(vencida.motivo).toBe('cancelada');
  });

  it('el motivo guardado se oculta si el estado efectivo no es prueba_vencida/vencida', async () => {
    const { service, suscripcionRepository } = buildService();
    suscripcionRepository.findOne.mockResolvedValue(
      buildFila({
        estado: 'activa',
        renovacionAutomatica: true,
        motivo: 'cobro_fallido',
      }),
    );
    const snap = await service.snapshot(USUARIO, new Date());
    expect(snap.motivo).toBeNull();
  });

  it('tiene exactamente las 10 claves, ahora_servidor en ISO con -06:00 y nunca gracia', async () => {
    const { service, suscripcionRepository } = buildService();
    suscripcionRepository.findOne.mockResolvedValue(buildFila());

    const snap = await service.snapshot(USUARIO, new Date());

    expect(Object.keys(snap).sort()).toEqual([...CLAVES_SNAPSHOT].sort());
    expect(snap.ahora_servidor).toMatch(ISO_NEGOCIO);
    expect(snap.prueba_inicio).toMatch(ISO_NEGOCIO);
    expect(snap.prueba_fin).toMatch(ISO_NEGOCIO);
    expect(snap).not.toHaveProperty('gracia_fin');
    expect(JSON.stringify(snap)).not.toContain('gracia');
  });

  it('sin fila: llama a crearPrueba con usuario.createdAt y vuelve a leer', async () => {
    const { service, suscripcionRepository, manager } = buildService();
    suscripcionRepository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(buildFila());

    const snap = await service.snapshot(
      USUARIO,
      new Date('2026-03-10T10:00:00-06:00'),
    );

    expect(manager.query).toHaveBeenCalledTimes(1);
    const [, params] = manager.query.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe('user-1');
    expect(params[1]).toBe(USUARIO.createdAt);
    expect(suscripcionRepository.findOne).toHaveBeenCalledTimes(2);
    expect(snap.estado).toBe('prueba');
  });
});

describe('SuscripcionesService.snapshot: historial', () => {
  it('sin pagos: historial vacío', async () => {
    const { service, suscripcionRepository } = buildService();
    suscripcionRepository.findOne.mockResolvedValue(buildFila());

    const snap = await service.snapshot(USUARIO);

    expect(snap.historial).toEqual([]);
  });

  it('mapea los pagos y pide orden descendente con take MAX_HISTORIAL', async () => {
    const { service, suscripcionRepository, pagoHistorialRepository } =
      buildService();
    suscripcionRepository.findOne.mockResolvedValue(buildFila());
    pagoHistorialRepository.find.mockResolvedValue([
      {
        externalId: 'GPA.2',
        periodo: '2026-04',
        cobradoEn: new Date('2026-04-14T20:05:00Z'),
        monto: 49,
        moneda: 'MXN ',
        estado: 'pagado',
      },
      {
        externalId: 'GPA.1',
        periodo: '2026-03',
        cobradoEn: new Date('2026-03-14T20:05:00Z'),
        monto: 49.5,
        moneda: 'MXN',
        estado: 'reembolsado',
      },
    ]);

    const snap = await service.snapshot(USUARIO);

    expect(MAX_HISTORIAL).toBe(24);
    expect(pagoHistorialRepository.find).toHaveBeenCalledWith({
      where: { usuarioId: 'user-1' },
      order: { cobradoEn: 'DESC', createdAt: 'DESC' },
      take: 24,
    });
    expect(snap.historial).toEqual([
      {
        id: 'GPA.2',
        periodo: '2026-04',
        cobrado_en: '2026-04-14T14:05:00-06:00',
        monto: 49,
        moneda: 'MXN',
        estado: 'pagado',
      },
      {
        id: 'GPA.1',
        periodo: '2026-03',
        cobrado_en: '2026-03-14T14:05:00-06:00',
        monto: 49.5,
        moneda: 'MXN',
        estado: 'reembolsado',
      },
    ]);
    expect(typeof snap.historial[0].monto).toBe('number');
    expect(snap.historial[0].cobrado_en).toMatch(ISO_NEGOCIO);
  });
});

describe('SuscripcionesService.crearPrueba', () => {
  it('es idempotente: INSERT ... ON CONFLICT ("usuario_id") DO NOTHING', async () => {
    const { service, manager } = buildService();

    await service.crearPrueba('user-1', new Date('2026-03-03T09:12:00-06:00'));
    await service.crearPrueba('user-1', new Date('2026-03-03T09:12:00-06:00'));

    expect(manager.query).toHaveBeenCalledTimes(2);
    const [sql] = manager.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO "suscripciones"');
    expect(sql).toContain('ON CONFLICT ("usuario_id") DO NOTHING');
  });

  it('prueba_fin = finDePrueba(inicio) y estado_desde = inicio', async () => {
    const { service, manager } = buildService();
    const inicio = new Date('2026-03-03T09:12:00-06:00');

    await service.crearPrueba('user-1', inicio);

    const [, params] = manager.query.mock.calls[0] as [string, Date[]];
    expect(params[1]).toEqual(inicio);
    expect(params[2].toISOString()).toBe('2026-03-17T05:59:59.000Z');
  });

  it('usa el manager recibido (transacción del llamador) en vez del del repositorio', async () => {
    const { service, manager } = buildService();
    const otroManager = { query: jest.fn().mockResolvedValue([]) };

    await service.crearPrueba('user-1', new Date(), otroManager as never);

    expect(otroManager.query).toHaveBeenCalledTimes(1);
    expect(manager.query).not.toHaveBeenCalled();
  });
});

describe('SuscripcionesService.estaBloqueada / assertPuedeEscribir', () => {
  const AHORA = new Date('2026-03-20T10:00:00-06:00');
  const FUTURO = new Date('2026-04-20T10:00:00-06:00');
  const PASADO = new Date('2026-03-10T10:00:00-06:00');

  const casos: Array<[string, Partial<Suscripcion>, boolean]> = [
    [
      'prueba vigente',
      { pruebaFin: new Date('2026-03-25T23:59:59-06:00') },
      false,
    ],
    ['prueba con prueba_fin pasado', { pruebaFin: PASADO }, true],
    [
      'activa con renovación',
      { estado: 'activa', renovacionAutomatica: true, accesoHasta: PASADO },
      false,
    ],
    [
      'cancelada con acceso_hasta futuro',
      { estado: 'cancelada', accesoHasta: FUTURO },
      false,
    ],
    [
      'cancelada con acceso_hasta pasado',
      { estado: 'cancelada', accesoHasta: PASADO },
      true,
    ],
    ['vencida', { estado: 'vencida', motivo: 'cobro_fallido' }, true],
    [
      'pago_en_proceso',
      { estado: 'pago_en_proceso', tienda: 'google_play' },
      true,
    ],
  ];

  it.each(casos)('estaBloqueada: %s', async (_nombre, fila, esperado) => {
    const { service, suscripcionRepository, pagoHistorialRepository } =
      buildService();
    suscripcionRepository.findOne.mockResolvedValue(buildFila(fila));

    await expect(service.estaBloqueada(USUARIO, AHORA)).resolves.toBe(esperado);
    expect(suscripcionRepository.findOne).toHaveBeenCalledTimes(1);
    expect(pagoHistorialRepository.find).not.toHaveBeenCalled();
  });

  it.each(casos)(
    'assertPuedeEscribir: %s',
    async (_nombre, fila, bloqueada) => {
      const { service, suscripcionRepository } = buildService();
      suscripcionRepository.findOne.mockResolvedValue(buildFila(fila));

      if (bloqueada) {
        const error = await service
          .assertPuedeEscribir(USUARIO, AHORA)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).message).toBe(
          'SUSCRIPCION_REQUERIDA: tu suscripción no está activa',
        );
      } else {
        await expect(
          service.assertPuedeEscribir(USUARIO, AHORA),
        ).resolves.toBeUndefined();
      }
    },
  );

  it('una cuenta sin fila se repara y no queda bloqueada', async () => {
    const { service, suscripcionRepository, manager } = buildService();
    suscripcionRepository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        buildFila({ pruebaFin: new Date('2026-03-25T23:59:59-06:00') }),
      );

    await expect(service.estaBloqueada(USUARIO, AHORA)).resolves.toBe(false);
    expect(manager.query).toHaveBeenCalledTimes(1);
    expect(manager.query).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([USUARIO.id]),
    );
  });
});
