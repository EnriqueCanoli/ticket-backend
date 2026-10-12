import {
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import type { DataSource } from 'typeorm';
import {
  CompraSuscripcionService,
  MENSAJE_COMPRA_RECHAZADA,
  MENSAJE_PRODUCTO_INVALIDO,
  MENSAJE_TIENDA_EN_USO,
} from './compra-suscripcion.service';
import { MENSAJE_TIENDA_NO_DISPONIBLE } from './verificadores/verificador-google';
import { Compra } from './entities/compra.entity';
import { Suscripcion } from './entities/suscripcion.entity';
import {
  calcularCuentaOfuscada,
  CuentaOfuscadaService,
} from './cuenta-ofuscada';
import type { SuscripcionesService } from './suscripciones.service';
import type { ResultadoVerificacion } from './verificadores/verificador-tienda.interface';
import type { RestaurarComprasDto } from './dto/restaurar-compras.dto';

/**
 * Specs unitarios sin BD: DataSource, manager, repositorios y verificador
 * mockeados.
 */

const USUARIO = {
  id: 'user-1',
  createdAt: new Date('2026-03-03T09:12:00-06:00'),
};
const PRODUCTO = 'PENDIENTE';
const TOKEN = 'mock-compra-user-1-1';
const SECRETO = 'secreto-de-prueba-con-mas-de-32-caracteres';
const CUENTA_PROPIA = calcularCuentaOfuscada('user-1', SECRETO);
const SNAPSHOT = { estado: 'activa', historial: [] };

function ms(dias: number): Date {
  return new Date(Date.now() + dias * 86_400_000);
}

function fila(parcial: Partial<Suscripcion> = {}): Suscripcion {
  return {
    id: 'sus-1',
    usuarioId: USUARIO.id,
    estado: 'prueba',
    pruebaInicio: ms(-15),
    pruebaFin: ms(-1),
    accesoHasta: null,
    proximoCobro: null,
    renovacionAutomatica: false,
    tienda: null,
    motivo: null,
    estadoDesde: ms(-15),
    ...parcial,
  } as Suscripcion;
}

function compra(parcial: Partial<Compra> = {}): Compra {
  return {
    id: 'compra-1',
    usuarioId: USUARIO.id,
    suscripcionId: 'sus-1',
    tienda: 'google_play',
    productoId: PRODUCTO,
    purchaseToken: TOKEN,
    orderId: 'SIM-1',
    estado: 'pendiente',
    periodoInicio: null,
    periodoFin: null,
    reconocidaEn: null,
    ...parcial,
  } as Compra;
}

function activa(
  parcial: Partial<ResultadoVerificacion> = {},
): ResultadoVerificacion {
  const inicio = new Date();
  return {
    estado: 'activa',
    orderId: 'SIM-abc',
    periodoInicio: inicio,
    periodoFin: new Date(inicio.getTime() + 30 * 86_400_000),
    autoRenovacion: true,
    cuentaOfuscada: null,
    monto: 99,
    moneda: 'MXN',
    yaReconocida: false,
    ...parcial,
  };
}

function pendiente(): ResultadoVerificacion {
  return {
    estado: 'pendiente',
    orderId: 'SIM-pend',
    periodoInicio: null,
    periodoFin: null,
    autoRenovacion: false,
    cuentaOfuscada: null,
    monto: null,
    moneda: null,
    yaReconocida: false,
  };
}

function rechazada(): ResultadoVerificacion {
  return { ...pendiente(), estado: 'rechazada', orderId: null };
}

function violacionUnica(): QueryFailedError {
  return new QueryFailedError('INSERT', [], {
    code: '23505',
  } as unknown as Error);
}

function build(
  opciones: { fila?: Suscripcion; verificacion?: ResultadoVerificacion } = {},
) {
  const filaDb = opciones.fila ?? fila();
  const compraRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const txCompraRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((datos: Partial<Compra>) => ({ ...datos }) as Compra),
    save: jest.fn((c: Compra) => Promise.resolve({ ...c, id: 'compra-nueva' })),
  };
  const txSuscripcionRepo = {
    findOne: jest.fn().mockResolvedValue(filaDb),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const manager = {
    getRepository: jest.fn((entidad: unknown) =>
      entidad === Compra ? txCompraRepo : txSuscripcionRepo,
    ),
    query: jest.fn().mockResolvedValue([]),
  };
  const dataSource = {
    transaction: jest.fn((cb: (m: typeof manager) => Promise<unknown>) =>
      cb(manager),
    ),
  };
  const suscripcionesService = {
    obtenerFila: jest.fn().mockResolvedValue(filaDb),
    snapshot: jest.fn().mockResolvedValue(SNAPSHOT),
  };
  const verificador = {
    verificar: jest.fn().mockResolvedValue(opciones.verificacion ?? activa()),
    reconocer: jest.fn().mockResolvedValue(undefined),
  };
  const service = new CompraSuscripcionService(
    dataSource as unknown as DataSource,
    compraRepo as never,
    suscripcionesService as unknown as SuscripcionesService,
    verificador,
    {
      validacionTienda: 'simulada',
      productoSuscripcionId: PRODUCTO,
      paqueteAndroid: null,
      credencialesGoogle: null,
      hmacSecreto: SECRETO,
    },
    new CuentaOfuscadaService({ hmacSecreto: SECRETO } as never),
  );
  return {
    service,
    compraRepo,
    txCompraRepo,
    txSuscripcionRepo,
    manager,
    dataSource,
    suscripcionesService,
    verificador,
  };
}

const validar = (
  service: CompraSuscripcionService,
  token = TOKEN,
  producto = PRODUCTO,
) =>
  service.validarCompra(USUARIO, {
    tienda: 'google_play',
    producto_id: producto,
    token_compra: token,
  });

describe('CompraSuscripcionService.validarCompra', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('producto erróneo: 400 PRODUCTO_INVALIDO sin llamar al verificador', async () => {
    const h = build();
    await expect(validar(h.service, TOKEN, 'otro')).rejects.toThrow(
      new BadRequestException(MENSAJE_PRODUCTO_INVALIDO),
    );
    expect(h.verificador.verificar).not.toHaveBeenCalled();
  });

  it('compra existente de otra cuenta: 409', async () => {
    const h = build();
    h.compraRepo.findOne.mockResolvedValue(compra({ usuarioId: 'otro' }));
    await expect(validar(h.service)).rejects.toThrow(
      new ConflictException(MENSAJE_TIENDA_EN_USO),
    );
    expect(h.verificador.verificar).not.toHaveBeenCalled();
    expect(h.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('compra propia confirmada: ni verifica ni abre transacción', async () => {
    const h = build();
    h.compraRepo.findOne.mockResolvedValue(
      compra({ estado: 'confirmada', reconocidaEn: new Date() }),
    );
    await expect(validar(h.service)).resolves.toBe(SNAPSHOT);
    expect(h.verificador.verificar).not.toHaveBeenCalled();
    expect(h.dataSource.transaction).not.toHaveBeenCalled();
    expect(h.verificador.reconocer).not.toHaveBeenCalled();
  });

  it('compra propia pendiente: se vuelve a verificar y se confirma aunque haya un mes vigente', async () => {
    const h = build({
      fila: fila({
        estado: 'activa',
        accesoHasta: ms(10),
        proximoCobro: ms(10),
        renovacionAutomatica: true,
      }),
    });
    const previa = compra({ estado: 'pendiente' });
    h.compraRepo.findOne.mockResolvedValueOnce(previa);
    h.txCompraRepo.findOne.mockResolvedValue(previa);

    await validar(h.service);

    expect(h.verificador.verificar).toHaveBeenCalledTimes(1);
    expect(h.txCompraRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'compra-1', estado: 'confirmada' }),
    );
    expect(h.txSuscripcionRepo.update).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('rechazada: 400 COMPRA_RECHAZADA', async () => {
    const h = build({ verificacion: rechazada() });
    await expect(validar(h.service)).rejects.toThrow(
      new BadRequestException(MENSAJE_COMPRA_RECHAZADA),
    );
    expect(h.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('cuentaOfuscada ajena (HMAC de otra cuenta): 409', async () => {
    const h = build({
      verificacion: activa({
        cuentaOfuscada: calcularCuentaOfuscada('otro-usuario', SECRETO),
      }),
    });
    await expect(validar(h.service)).rejects.toThrow(
      new ConflictException(MENSAJE_TIENDA_EN_USO),
    );
    expect(h.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('cuentaOfuscada igual al HMAC propio acepta', async () => {
    const h = build({
      verificacion: activa({ cuentaOfuscada: CUENTA_PROPIA }),
    });
    await expect(validar(h.service)).resolves.toBe(SNAPSHOT);
    expect(h.dataSource.transaction).toHaveBeenCalled();
  });

  it('el id sin ofuscar ya no cuenta como cuenta propia', async () => {
    const h = build({ verificacion: activa({ cuentaOfuscada: USUARIO.id }) });
    await expect(validar(h.service)).rejects.toThrow(ConflictException);
  });

  it('sin cuentaOfuscada (null) acepta y liga a la cuenta que la envía (E8)', async () => {
    const h = build({ verificacion: activa({ cuentaOfuscada: null }) });
    await expect(validar(h.service)).resolves.toBe(SNAPSHOT);
    expect(h.txCompraRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ usuarioId: USUARIO.id }),
    );
  });

  it('autoRenovacion=false: activa sin proximo_cobro ni renovación', async () => {
    const h = build({ verificacion: activa({ autoRenovacion: false }) });
    await validar(h.service);
    expect(h.txSuscripcionRepo.update).toHaveBeenCalledWith(
      { id: 'sus-1' },
      expect.objectContaining({
        estado: 'activa',
        proximoCobro: null,
        renovacionAutomatica: false,
      }),
    );
  });

  it('yaReconocida: guarda reconocida_en y no llama a reconocer', async () => {
    const h = build({ verificacion: activa({ yaReconocida: true }) });
    h.compraRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(
      compra({
        id: 'compra-nueva',
        estado: 'confirmada',
        reconocidaEn: new Date(),
      }),
    );
    await validar(h.service);
    expect(h.txCompraRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ reconocidaEn: expect.any(Date) as Date }),
    );
    expect(h.verificador.reconocer).not.toHaveBeenCalled();
  });

  it('monto o moneda null: inserta 0 con un aviso', async () => {
    const h = build({ verificacion: activa({ monto: null, moneda: null }) });
    await validar(h.service);
    const params = (h.manager.query.mock.calls[0] as [string, unknown[]])[1];
    expect(params[6]).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('TIENDA_NO_DISPONIBLE: se propaga sin tocar la BD', async () => {
    const h = build();
    h.verificador.verificar.mockRejectedValue(
      new ServiceUnavailableException(MENSAJE_TIENDA_NO_DISPONIBLE),
    );
    await expect(validar(h.service)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(h.dataSource.transaction).not.toHaveBeenCalled();
    expect(h.compraRepo.update).not.toHaveBeenCalled();
  });

  describe('E12: compra propia pendiente que sale rechazada', () => {
    function preparar(filaDb: Suscripcion, otras = 0) {
      const h = build({ fila: filaDb, verificacion: rechazada() });
      const previa = compra({ estado: 'pendiente' });
      h.compraRepo.findOne.mockResolvedValueOnce(previa);
      h.txCompraRepo.findOne.mockResolvedValue(previa);
      const txCompra = Object.assign(h.txCompraRepo, {
        update: jest.fn().mockResolvedValue(undefined),
        count: jest.fn().mockResolvedValue(otras),
      });
      return { ...h, txCompra };
    }

    it('nunca pagó: expirada y vuelve a prueba_vencida / prueba_terminada', async () => {
      const h = preparar(fila({ estado: 'pago_en_proceso' }));
      await expect(validar(h.service)).rejects.toThrow(
        new BadRequestException(MENSAJE_COMPRA_RECHAZADA),
      );
      expect(h.txCompra.update).toHaveBeenCalledWith(
        { id: 'compra-1' },
        { estado: 'expirada' },
      );
      expect(h.txSuscripcionRepo.update).toHaveBeenCalledWith(
        { id: 'sus-1' },
        expect.objectContaining({
          estado: 'prueba_vencida',
          motivo: 'prueba_terminada',
          estadoDesde: expect.any(Date) as Date,
        }),
      );
    });

    it('ya había pagado: vuelve a vencida / cancelada', async () => {
      const h = preparar(
        fila({ estado: 'pago_en_proceso', accesoHasta: ms(-3) }),
      );
      await expect(validar(h.service)).rejects.toThrow(BadRequestException);
      expect(h.txSuscripcionRepo.update).toHaveBeenCalledWith(
        { id: 'sus-1' },
        expect.objectContaining({ estado: 'vencida', motivo: 'cancelada' }),
      );
    });

    it('si queda otra compra pendiente, no cambia la suscripción', async () => {
      const h = preparar(fila({ estado: 'pago_en_proceso' }), 1);
      await expect(validar(h.service)).rejects.toThrow(BadRequestException);
      expect(h.txCompra.update).toHaveBeenCalled();
      expect(h.txSuscripcionRepo.update).not.toHaveBeenCalled();
    });

    it('si la cuenta no estaba en pago_en_proceso, solo expira la compra', async () => {
      const h = preparar(fila({ estado: 'prueba' }));
      await expect(validar(h.service)).rejects.toThrow(BadRequestException);
      expect(h.txCompra.update).toHaveBeenCalled();
      expect(h.txSuscripcionRepo.update).not.toHaveBeenCalled();
    });
  });

  it('activa sobre prueba vencida: bloquea la fila, crea compra y pago, actualiza la suscripción y reconoce', async () => {
    const h = build();
    const resultado = activa();
    h.verificador.verificar.mockResolvedValue(resultado);
    h.compraRepo.findOne
      .mockResolvedValueOnce(null) // lectura previa
      .mockResolvedValueOnce(
        compra({ id: 'compra-nueva', estado: 'confirmada' }),
      ); // tras el commit

    await expect(validar(h.service)).resolves.toBe(SNAPSHOT);

    expect(h.txSuscripcionRepo.findOne).toHaveBeenCalledWith({
      where: { usuarioId: USUARIO.id },
      lock: { mode: 'pessimistic_write' },
    });
    expect(h.txCompraRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        estado: 'confirmada',
        purchaseToken: TOKEN,
        orderId: 'SIM-abc',
        periodoInicio: resultado.periodoInicio,
        periodoFin: resultado.periodoFin,
      }),
    );
    const [sql, params] = h.manager.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT ("tienda", "external_id") DO NOTHING');
    expect(params).toEqual([
      USUARIO.id,
      'compra-nueva',
      'google_play',
      'SIM-abc',
      expect.stringMatching(/^\d{4}-\d{2}$/),
      resultado.periodoInicio,
      99,
      'MXN',
    ]);
    expect(h.txSuscripcionRepo.update).toHaveBeenCalledWith(
      { id: 'sus-1' },
      expect.objectContaining({
        estado: 'activa',
        accesoHasta: resultado.periodoFin,
        proximoCobro: resultado.periodoFin,
        renovacionAutomatica: true,
        tienda: 'google_play',
        motivo: null,
        estadoDesde: expect.any(Date) as Date,
      }),
    );
    const cambio = (
      h.txSuscripcionRepo.update.mock.calls[0] as [unknown, object]
    )[1];
    expect(cambio).not.toHaveProperty('pruebaInicio');
    expect(cambio).not.toHaveProperty('pruebaFin');
    expect(h.verificador.reconocer).toHaveBeenCalledWith({
      productoId: PRODUCTO,
      tokenCompra: TOKEN,
    });
    expect(h.compraRepo.update).toHaveBeenCalledWith(
      { id: 'compra-nueva' },
      { reconocidaEn: expect.any(Date) as Date },
    );
  });

  it('activa sobre una prueba vigente: activa (la prueba no se respeta)', async () => {
    const h = build({
      fila: fila({ pruebaInicio: ms(-3), pruebaFin: ms(11) }),
    });
    await validar(h.service);
    expect(h.txSuscripcionRepo.update).toHaveBeenCalledWith(
      { id: 'sus-1' },
      expect.objectContaining({ estado: 'activa' }),
    );
    expect(h.manager.query).toHaveBeenCalledTimes(1);
  });

  it('no cambia estado_desde si el estado guardado ya era activa', async () => {
    const h = build({
      fila: fila({
        estado: 'activa',
        accesoHasta: ms(-1),
        renovacionAutomatica: false,
      }),
    });
    await validar(h.service);
    const cambio = (
      h.txSuscripcionRepo.update.mock.calls[0] as [unknown, object]
    )[1];
    expect(cambio).not.toHaveProperty('estadoDesde');
  });

  it.each([
    [
      'activa vigente',
      fila({
        estado: 'activa',
        accesoHasta: ms(10),
        proximoCobro: ms(10),
        renovacionAutomatica: true,
      }),
    ],
    [
      'cancelada vigente',
      fila({ estado: 'cancelada', accesoHasta: ms(10), motivo: 'cancelada' }),
    ],
  ])(
    'D2: token nuevo con %s: ignorada, sin escrituras, sin reconocer y con warn',
    async (_nombre, filaVigente) => {
      const h = build({ fila: filaVigente });
      await expect(validar(h.service)).resolves.toBe(SNAPSHOT);

      expect(h.txCompraRepo.save).not.toHaveBeenCalled();
      expect(h.manager.query).not.toHaveBeenCalled();
      expect(h.txSuscripcionRepo.update).not.toHaveBeenCalled();
      expect(h.verificador.reconocer).not.toHaveBeenCalled();
      expect(h.compraRepo.update).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      const mensaje = String((warn.mock.calls[0] as string[])[0]);
      expect(mensaje).toContain(USUARIO.id);
      expect(mensaje).toContain('SIM-abc');
      expect(mensaje).not.toContain(TOKEN);
    },
  );

  it.each([
    ['prueba vigente', fila({ pruebaInicio: ms(-10), pruebaFin: ms(4) })],
    [
      'activa vigente',
      fila({
        estado: 'activa',
        accesoHasta: ms(10),
        proximoCobro: ms(10),
        renovacionAutomatica: true,
      }),
    ],
    [
      'cancelada vigente',
      fila({ estado: 'cancelada', accesoHasta: ms(10), motivo: 'cancelada' }),
    ],
  ])(
    'D1: pendiente con %s: guarda la compra y NO cambia la suscripción',
    async (_nombre, filaConDias) => {
      const h = build({ fila: filaConDias, verificacion: pendiente() });
      await validar(h.service, 'mock-pendiente-user-1-1');

      expect(h.txCompraRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ estado: 'pendiente' }),
      );
      expect(h.txSuscripcionRepo.update).not.toHaveBeenCalled();
      expect(h.manager.query).not.toHaveBeenCalled();
      expect(h.verificador.reconocer).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['prueba vencida', fila()],
    ['vencida', fila({ estado: 'vencida', motivo: 'cancelada' })],
    ['pago_en_proceso', fila({ estado: 'pago_en_proceso' })],
  ])(
    'D1: pendiente con %s: pago_en_proceso sin pago en el historial',
    async (_nombre, filaSinDias) => {
      const h = build({ fila: filaSinDias, verificacion: pendiente() });
      await validar(h.service, 'mock-pendiente-user-1-1');

      expect(h.txSuscripcionRepo.update).toHaveBeenCalledWith(
        { id: 'sus-1' },
        expect.objectContaining({
          estado: 'pago_en_proceso',
          tienda: 'google_play',
          renovacionAutomatica: false,
          proximoCobro: null,
          motivo: null,
        }),
      );
      const cambio = (
        h.txSuscripcionRepo.update.mock.calls[0] as [unknown, object]
      )[1];
      expect(cambio).not.toHaveProperty('accesoHasta');
      expect(h.manager.query).not.toHaveBeenCalled();
    },
  );

  it('23505 por carrera: relee y responde 409 si la compra es de otra cuenta', async () => {
    const h = build();
    h.dataSource.transaction.mockRejectedValue(violacionUnica());
    h.compraRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        compra({ usuarioId: 'otro', estado: 'confirmada' }),
      );
    await expect(validar(h.service)).rejects.toThrow(
      new ConflictException(MENSAJE_TIENDA_EN_USO),
    );
  });

  it('23505 por carrera: relee y responde ok si la compra es propia', async () => {
    const h = build();
    h.dataSource.transaction.mockRejectedValue(violacionUnica());
    h.compraRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(compra({ estado: 'confirmada' }));
    await expect(validar(h.service)).resolves.toBe(SNAPSHOT);
  });

  it('otro error de la transacción se relanza', async () => {
    const h = build();
    h.dataSource.transaction.mockRejectedValue(new Error('boom'));
    await expect(validar(h.service)).rejects.toThrow('boom');
  });

  it('un fallo de reconocer no rompe la activación', async () => {
    const h = build();
    h.verificador.reconocer.mockRejectedValue(new Error('google caído'));
    h.compraRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        compra({ id: 'compra-nueva', estado: 'confirmada' }),
      );

    await expect(validar(h.service)).resolves.toBe(SNAPSHOT);
    expect(h.verificador.reconocer).toHaveBeenCalled();
    expect(h.compraRepo.update).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
});

describe('CompraSuscripcionService.restaurarCompras', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  const dto = (...tokens: string[]): RestaurarComprasDto => ({
    tienda: 'google_play',
    compras: tokens.map((token_compra) => ({
      producto_id: PRODUCTO,
      token_compra,
    })),
  });

  it('propia más ajena: 200 y aplica la propia', async () => {
    const h = build();
    h.compraRepo.findOne.mockImplementation(
      (opciones: { where: { purchaseToken?: string; id?: string } }) => {
        if (opciones.where.purchaseToken === 'mock-compra-ajena') {
          return Promise.resolve(
            compra({ usuarioId: 'otro', estado: 'confirmada' }),
          );
        }
        if (opciones.where.id) {
          return Promise.resolve(
            compra({ id: 'compra-nueva', estado: 'confirmada' }),
          );
        }
        return Promise.resolve(null);
      },
    );
    await expect(
      h.service.restaurarCompras(USUARIO, dto('mock-compra-ajena', TOKEN)),
    ).resolves.toBe(SNAPSHOT);
    expect(h.txSuscripcionRepo.update).toHaveBeenCalledTimes(1);
  });

  it('solo ajena: 409', async () => {
    const h = build();
    h.compraRepo.findOne.mockResolvedValue(compra({ usuarioId: 'otro' }));
    await expect(
      h.service.restaurarCompras(USUARIO, dto('mock-compra-ajena')),
    ).rejects.toThrow(new ConflictException(MENSAJE_TIENDA_EN_USO));
  });

  it('solo inválidas: snapshot sin cambios', async () => {
    const h = build({ verificacion: rechazada() });
    await expect(
      h.service.restaurarCompras(USUARIO, dto('basura-1', 'basura-2')),
    ).resolves.toBe(SNAPSHOT);
    expect(h.txSuscripcionRepo.update).not.toHaveBeenCalled();
  });

  it('inválidas más ajena sin ninguna propia: 409', async () => {
    const h = build({ verificacion: rechazada() });
    h.compraRepo.findOne.mockImplementation(
      (opciones: { where: { purchaseToken?: string } }) =>
        Promise.resolve(
          opciones.where.purchaseToken === 'mock-compra-ajena'
            ? compra({ usuarioId: 'otro' })
            : null,
        ),
    );
    await expect(
      h.service.restaurarCompras(USUARIO, dto('basura', 'mock-compra-ajena')),
    ).rejects.toThrow(ConflictException);
  });

  it('arreglo vacío: snapshot actual', async () => {
    const h = build();
    await expect(h.service.restaurarCompras(USUARIO, dto())).resolves.toBe(
      SNAPSHOT,
    );
    expect(h.verificador.verificar).not.toHaveBeenCalled();
  });

  it('deduplica los tokens repetidos', async () => {
    const h = build({ verificacion: rechazada() });
    await h.service.restaurarCompras(USUARIO, dto('x', 'x', 'x'));
    expect(h.verificador.verificar).toHaveBeenCalledTimes(1);
  });

  it('un error inesperado se relanza', async () => {
    const h = build();
    h.verificador.verificar.mockRejectedValue(new Error('boom'));
    await expect(
      h.service.restaurarCompras(USUARIO, dto(TOKEN)),
    ).rejects.toThrow('boom');
  });
});
