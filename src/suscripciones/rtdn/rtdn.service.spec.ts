import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CuentaOfuscadaService } from '../cuenta-ofuscada';
import type { ConfigSuscripcion } from '../config-suscripcion';
import type { SuscripcionGoogle } from '../verificadores/google-play-api';
import { RtdnService } from './rtdn.service';

const SECRETO = 'un-secreto-de-prueba-de-al-menos-32-caracteres';
const PRODUCTO = 'ticket_mensual';
const config: ConfigSuscripcion = {
  validacionTienda: 'simulada',
  productoSuscripcionId: PRODUCTO,
  paqueteAndroid: 'com.canales.ticket',
  credencialesGoogle: null,
  hmacSecreto: SECRETO,
  pubsubAudiencia: null,
  pubsubEmail: null,
  rtdnVerificarOidc: false,
};
const cuenta = new CuentaOfuscadaService(config);

const b64 = (objeto: unknown) =>
  Buffer.from(JSON.stringify(objeto)).toString('base64');
const aviso = (tipo: number, token = 'tok-nuevo', extra = {}) =>
  b64({
    version: '1.0',
    packageName: 'com.canales.ticket',
    eventTimeMillis: '1773500000000',
    subscriptionNotification: {
      version: '1.0',
      notificationType: tipo,
      purchaseToken: token,
    },
    ...extra,
  });

interface CompraFalsa {
  id: string;
  usuarioId: string;
  estado: string;
  purchaseToken: string;
  orderId: string | null;
  periodoFin: Date | null;
}

function construir(opciones: {
  compras?: CompraFalsa[];
  usuarios?: Array<{ id: string; createdAt: Date }>;
  google?: SuscripcionGoogle | Error;
  eventoPrevio?: { procesadoEn: Date | null } | null;
  aplicar?: jest.Mock;
}) {
  const compras = opciones.compras ?? [];
  const usuarios = opciones.usuarios ?? [];
  const insertadas = opciones.eventoPrevio ? [] : [{ id: 'evento-1' }];
  const dataSource = {
    query: jest.fn().mockResolvedValue(insertadas),
    getRepository: jest.fn().mockReturnValue({
      findOne: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(usuarios.find((u) => u.id === where.id) ?? null),
      ),
      find: jest.fn().mockResolvedValue(usuarios),
    }),
    transaction: jest.fn(),
  };
  const compraRepo = {
    findOne: jest.fn(
      ({ where }: { where: { purchaseToken?: string; id?: string } }) =>
        Promise.resolve(
          compras.find(
            (c) => c.purchaseToken === where.purchaseToken || c.id === where.id,
          ) ?? null,
        ),
    ),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const eventoRepo = {
    findOne: jest.fn().mockResolvedValue(opciones.eventoPrevio ?? null),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const pagoRepo = { exists: jest.fn().mockResolvedValue(false) };
  const fuente = {
    obtener: jest.fn(() =>
      opciones.google instanceof Error
        ? Promise.reject(opciones.google)
        : Promise.resolve(opciones.google ?? {}),
    ),
  };
  const aplicarCompra =
    opciones.aplicar ?? jest.fn().mockResolvedValue('aplicada');
  const compraSuscripcion = {
    aplicarCompraDeTienda: aplicarCompra,
    reconocerSiHaceFalta: jest.fn(),
  };
  const service = new RtdnService(
    dataSource as never,
    compraRepo as never,
    eventoRepo as never,
    pagoRepo as never,
    config,
    fuente,
    null,
    cuenta,
    compraSuscripcion as never,
  );
  return {
    service,
    dataSource,
    compraRepo,
    eventoRepo,
    fuente,
    aplicarCompra,
    compraSuscripcion,
  };
}

const ultimaActualizacion = (eventoRepo: { update: jest.Mock }) =>
  (
    eventoRepo.update.mock.calls.at(-1) as [unknown, Record<string, unknown>]
  )[1];

const viejaCompra = (): CompraFalsa => ({
  id: 'compra-vieja',
  usuarioId: 'u1',
  estado: 'confirmada',
  purchaseToken: 'tok-viejo',
  orderId: 'GPA.0',
  periodoFin: new Date('2026-03-01T00:00:00Z'),
});

describe('RtdnService', () => {
  describe('mensajes que no tocan la BD de suscripciones', () => {
    it('data no decodificable: mensaje_invalido con payload {"invalido":true}', async () => {
      const { service, dataSource, eventoRepo, fuente } = construir({});
      const r = await service.procesar('m1', '%%%');
      expect(r).toEqual({ duplicado: false, resultado: 'mensaje_invalido' });
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT ("message_id") DO NOTHING'),
        ['m1', 'DESCONOCIDO', '{"invalido":true}'],
      );
      expect(fuente.obtener).not.toHaveBeenCalled();
      expect(ultimaActualizacion(eventoRepo)).toMatchObject({
        resultado: 'mensaje_invalido',
        error: null,
      });
    });

    it('testNotification: prueba', async () => {
      const { service, fuente } = construir({});
      const r = await service.procesar(
        'm2',
        b64({
          packageName: 'com.canales.ticket',
          testNotification: { version: '1.0' },
        }),
      );
      expect(r).toEqual({ duplicado: false, resultado: 'prueba' });
      expect(fuente.obtener).not.toHaveBeenCalled();
    });

    it('packageName ajeno: paquete_ajeno', async () => {
      const { service, fuente } = construir({});
      const r = await service.procesar(
        'm3',
        aviso(2, 't', { packageName: 'com.otra.app' }),
      );
      expect(r).toEqual({ duplicado: false, resultado: 'paquete_ajeno' });
      expect(fuente.obtener).not.toHaveBeenCalled();
    });

    it('voided que no es suscripción, oneTime y tipos sin uso: ignorado', async () => {
      for (const data of [
        b64({
          voidedPurchaseNotification: {
            purchaseToken: 't',
            orderId: 'o',
            productType: 2,
            refundType: 1,
          },
        }),
        b64({ oneTimeProductNotification: { purchaseToken: 't' } }),
        b64({ pendingRefundReviewNotification: { orderId: 'o' } }),
        aviso(11),
      ]) {
        const { service, fuente } = construir({});
        const r = await service.procesar('m4', data);
        expect(r).toEqual({ duplicado: false, resultado: 'ignorado' });
        expect(fuente.obtener).not.toHaveBeenCalled();
      }
    });

    it('un mensaje ya procesado se confirma sin hacer nada', async () => {
      const { service, fuente, eventoRepo } = construir({
        eventoPrevio: { procesadoEn: new Date() },
      });
      const r = await service.procesar('m5', aviso(2));
      expect(r).toEqual({ duplicado: true });
      expect(fuente.obtener).not.toHaveBeenCalled();
      expect(eventoRepo.update).not.toHaveBeenCalled();
    });

    it('un mensaje recibido pero sin procesar se vuelve a procesar', async () => {
      const { service, eventoRepo } = construir({
        eventoPrevio: { procesadoEn: null },
      });
      const r = await service.procesar('m6', aviso(11));
      expect(r).toEqual({ duplicado: false, resultado: 'ignorado' });
      expect(eventoRepo.update).toHaveBeenCalled();
    });
  });

  describe('errores de Google', () => {
    it.each([400, 404, 410])(
      'http %d: token_invalido y 200',
      async (status) => {
        const { service } = construir({
          google: Object.assign(new Error('x'), { status }),
        });
        const r = await service.procesar('m7', aviso(2));
        expect(r).toEqual({ duplicado: false, resultado: 'token_invalido' });
      },
    );

    it.each([401, 403, 429, 500, 503])(
      'http %d: 503 y el evento queda en error sin procesado_en',
      async (status) => {
        const { service, eventoRepo } = construir({
          google: Object.assign(new Error('token tok-nuevo'), { status }),
        });
        await expect(service.procesar('m8', aviso(2))).rejects.toThrow(
          ServiceUnavailableException,
        );
        const cambios = ultimaActualizacion(eventoRepo);
        expect(cambios).toMatchObject({ resultado: 'error' });
        expect(cambios.procesadoEn).toBeUndefined();
        expect(String(cambios.error)).not.toContain('tok-nuevo');
      },
    );

    it('fallo de red (sin código HTTP): 503', async () => {
      const { service } = construir({ google: new Error('ECONNRESET') });
      await expect(service.procesar('m9', aviso(2))).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('un error inesperado se registra y se relanza (500)', async () => {
      const { service, eventoRepo, compraRepo } = construir({ google: {} });
      compraRepo.findOne.mockRejectedValueOnce(new TypeError('bug'));
      await expect(service.procesar('m10', aviso(2))).rejects.toThrow(
        TypeError,
      );
      expect(ultimaActualizacion(eventoRepo)).toMatchObject({
        resultado: 'error',
        error: 'TypeError',
      });
    });
  });

  describe('compra que llega por aviso sin pasar por la app (F5)', () => {
    const usuario = { id: 'u1', createdAt: new Date('2026-01-01T00:00:00Z') };

    it('se liga por linkedPurchaseToken, aplica las reglas de validar-compra y expira la vieja', async () => {
      const { service, aplicarCompra, compraRepo } = construir({
        compras: [viejaCompra()],
        usuarios: [usuario],
        google: { linkedPurchaseToken: 'tok-viejo' },
      });
      const r = await service.procesar('f1', aviso(4));
      expect(r).toEqual({ duplicado: false, resultado: 'aplicado' });
      expect(aplicarCompra).toHaveBeenCalledWith(
        usuario,
        PRODUCTO,
        'tok-nuevo',
      );
      expect(compraRepo.update).toHaveBeenCalledWith(
        { id: 'compra-vieja', estado: 'confirmada' },
        { estado: 'expirada' },
      );
    });

    it('se liga por outOfAppPurchaseContext.expiredPurchaseToken (la vieja no se toca)', async () => {
      const { service, aplicarCompra, compraRepo } = construir({
        compras: [{ ...viejaCompra(), estado: 'expirada' }],
        usuarios: [usuario],
        google: {
          outOfAppPurchaseContext: { expiredPurchaseToken: 'tok-viejo' },
        },
      });
      const r = await service.procesar('f2', aviso(4));
      expect(r).toMatchObject({ resultado: 'aplicado' });
      expect(aplicarCompra).toHaveBeenCalledTimes(1);
      expect(compraRepo.update).not.toHaveBeenCalled();
    });

    it('se liga por el HMAC del obfuscatedExternalAccountId', async () => {
      const { service, aplicarCompra } = construir({
        usuarios: [{ id: 'u0', createdAt: new Date() }, usuario],
        google: {
          externalAccountIdentifiers: {
            obfuscatedExternalAccountId: cuenta.calcular('u1'),
          },
        },
      });
      const r = await service.procesar('f3', aviso(4));
      expect(r).toMatchObject({ resultado: 'aplicado' });
      expect(aplicarCompra).toHaveBeenCalledWith(
        usuario,
        PRODUCTO,
        'tok-nuevo',
      );
    });

    it('se liga por el HMAC de expiredExternalAccountIdentifiers', async () => {
      const { service, aplicarCompra } = construir({
        usuarios: [usuario],
        google: {
          outOfAppPurchaseContext: {
            expiredExternalAccountIdentifiers: {
              obfuscatedExternalAccountId: cuenta.calcular('u1'),
            },
          },
        },
      });
      await service.procesar('f4', aviso(4));
      expect(aplicarCompra).toHaveBeenCalledTimes(1);
    });

    it('sin dueño: compra_desconocida y nada más', async () => {
      const { service, aplicarCompra } = construir({
        usuarios: [usuario],
        google: {
          externalAccountIdentifiers: { obfuscatedExternalAccountId: 'ajeno' },
        },
      });
      const r = await service.procesar('f5', aviso(4));
      expect(r).toEqual({ duplicado: false, resultado: 'compra_desconocida' });
      expect(aplicarCompra).not.toHaveBeenCalled();
    });

    it('D2: con un mes pagado vigente la compra nueva se ignora y la vieja no se expira', async () => {
      const { service, compraRepo } = construir({
        compras: [viejaCompra()],
        usuarios: [usuario],
        google: { linkedPurchaseToken: 'tok-viejo' },
        aplicar: jest.fn().mockResolvedValue('ignorada_mes_vigente'),
      });
      const r = await service.procesar('f6', aviso(4));
      expect(r).toMatchObject({ resultado: 'd2_ignorada' });
      expect(compraRepo.update).not.toHaveBeenCalled();
    });

    it('BadRequest → rechazada y Conflict → conflicto, ambos con 200', async () => {
      for (const [error, esperado] of [
        [new BadRequestException(), 'rechazada'],
        [new ConflictException(), 'conflicto'],
      ] as const) {
        const { service } = construir({
          usuarios: [usuario],
          google: {
            externalAccountIdentifiers: {
              obfuscatedExternalAccountId: cuenta.calcular('u1'),
            },
          },
          aplicar: jest.fn().mockRejectedValue(error),
        });
        const r = await service.procesar('f7', aviso(4));
        expect(r).toMatchObject({ resultado: esperado });
      }
    });

    it('un reembolso de un token desconocido no liga nada', async () => {
      const { service, aplicarCompra, fuente } = construir({});
      const r = await service.procesar(
        'f8',
        b64({
          voidedPurchaseNotification: {
            purchaseToken: 'tok-x',
            orderId: 'GPA.9',
            productType: 1,
            refundType: 1,
          },
        }),
      );
      expect(r).toMatchObject({ resultado: 'compra_desconocida' });
      expect(aplicarCompra).not.toHaveBeenCalled();
      expect(fuente.obtener).not.toHaveBeenCalled();
    });
  });
});
