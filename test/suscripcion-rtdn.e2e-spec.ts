import { createHash } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { UnauthorizedException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/main';
import { Usuario } from '../src/usuarios/entities/usuario.entity';
import { Producto } from '../src/productos/entities/producto.entity';
import { Ticket } from '../src/tickets/entities/ticket.entity';
import { Suscripcion } from '../src/suscripciones/entities/suscripcion.entity';
import { SuscripcionesService } from '../src/suscripciones/suscripciones.service';
import { CONFIG_SUSCRIPCION } from '../src/suscripciones/config-suscripcion';
import type { ConfigSuscripcion } from '../src/suscripciones/config-suscripcion';
import { CuentaOfuscadaService } from '../src/suscripciones/cuenta-ofuscada';
import { FUENTE_ESTADO_GOOGLE } from '../src/suscripciones/rtdn/fuente-estado-google';
import { VERIFICADOR_PUSH } from '../src/suscripciones/rtdn/pubsub-auth';
import type { SuscripcionGoogle } from '../src/suscripciones/verificadores/google-play-api';

/**
 * Etapa 5: RTDN de Google Play (Postgres real). La fuente del estado de Google
 * y la verificación del push están sobrescritas: nunca se llama a Google. El
 * verificador de compras sigue siendo el simulado (tokens `mock-compra-`).
 * Solo 4 logins (throttle de 5 por minuto); el resto de las cuentas se siembra
 * por repositorio y se inspecciona por SQL.
 */
describe('RTDN de Google Play (etapa 5, e2e, Postgres real)', () => {
  let app: NestExpressApplication;
  let moduleFixture: TestingModule;
  let dataSource: DataSource;
  let usuarioRepository: Repository<Usuario>;
  let suscripcionRepository: Repository<Suscripcion>;
  let productoRepository: Repository<Producto>;
  let ticketRepository: Repository<Ticket>;
  let cuentaOfuscada: CuentaOfuscadaService;
  let producto: string;
  const password = 'password1';
  const unico = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const prefijoMsg = `susc-5-rtdn-${unico}`;
  const usuarios: Usuario[] = [];
  const productosCreados: Producto[] = [];

  const respuestas = new Map<string, () => Promise<SuscripcionGoogle>>();
  const fuenteFalsa = {
    obtener: ({ token }: { token: string }) => {
      const r = respuestas.get(token);
      return r
        ? r()
        : Promise.reject(
            Object.assign(new Error('no existe'), { status: 404 }),
          );
    },
  };
  const verificadorPushFalso = {
    verificar: (authorization?: string) =>
      authorization === 'Bearer valido'
        ? Promise.resolve()
        : Promise.reject(new UnauthorizedException()),
  };

  const http = () => app.getHttpServer() as App;
  const dia = 86_400_000;
  const enDias = (n: number) => new Date(Date.now() + n * dia);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
  const aviso = (tipo: number, token: string) =>
    b64({
      version: '1.0',
      packageName: 'com.canales.ticket',
      eventTimeMillis: String(Date.now()),
      subscriptionNotification: {
        version: '1.0',
        notificationType: tipo,
        purchaseToken: token,
      },
    });
  const voided = (token: string, orderId: string) =>
    b64({
      version: '1.0',
      packageName: 'com.canales.ticket',
      eventTimeMillis: String(Date.now()),
      voidedPurchaseNotification: {
        purchaseToken: token,
        orderId,
        productType: 1,
        refundType: 1,
      },
    });
  const enviar = (
    messageId: string | null,
    data: string,
    authorization: string | null = 'Bearer valido',
  ) => {
    const req = request(http()).post('/tienda/google/rtdn');
    if (authorization) req.set('Authorization', authorization);
    return req.send({
      message: {
        data,
        ...(messageId ? { messageId: `${prefijoMsg}-${messageId}` } : {}),
      },
      subscription: 'projects/x/subscriptions/y',
    });
  };

  const googleActivo = (
    estado: string,
    expiry: Date,
    orderId: string,
    extra: Partial<SuscripcionGoogle> = {},
    autoRenew = true,
  ): SuscripcionGoogle => ({
    subscriptionState: `SUBSCRIPTION_STATE_${estado}`,
    startTime: new Date().toISOString(),
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    lineItems: [
      {
        productId: producto,
        expiryTime: expiry.toISOString(),
        latestSuccessfulOrderId: orderId,
        autoRenewingPlan: {
          autoRenewEnabled: autoRenew,
          recurringPrice: { currencyCode: 'MXN', units: '99', nanos: 0 },
        },
      },
    ],
    ...extra,
  });
  const responder = (token: string, g: SuscripcionGoogle) =>
    respuestas.set(token, () => Promise.resolve(g));

  const crearUsuario = async (sufijo: string): Promise<Usuario> => {
    const u = await usuarioRepository.save(
      usuarioRepository.create({
        email: `susc-5-rtdn-${sufijo}-${unico}@example.com`,
        passwordHash: bcrypt.hashSync(password, 10),
        phone: String(
          Math.floor(1_000_000_000 + Math.random() * 8_999_999_999),
        ),
        pin: '0000',
        aceptoTerminos: true,
        tokenVersion: 0,
      }),
    );
    await moduleFixture
      .get(SuscripcionesService)
      .crearPrueba(u.id, u.createdAt);
    usuarios.push(u);
    return u;
  };

  /** Cuenta con un mes pagado vigente por una compra confirmada de Google. */
  const sembrarActiva = async (
    u: Usuario,
    token: string,
    orderId: string,
    diasRestantes: number,
  ): Promise<string> => {
    const fin = enDias(diasRestantes);
    await suscripcionRepository.update(
      { usuarioId: u.id },
      {
        estado: 'activa',
        accesoHasta: fin,
        proximoCobro: fin,
        renovacionAutomatica: true,
        tienda: 'google_play',
        motivo: null,
      },
    );
    const susc = await suscripcionRepository.findOneByOrFail({
      usuarioId: u.id,
    });
    const filas: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO compras (usuario_id, suscripcion_id, tienda, producto_id, purchase_token,
         order_id, estado, periodo_inicio, periodo_fin, reconocida_en)
       VALUES ($1, $2, 'google_play', $3, $4, $5, 'confirmada', now() - interval '1 day', $6, now())
       RETURNING id`,
      [u.id, susc.id, producto, token, orderId, fin],
    );
    await dataSource.query(
      `INSERT INTO pagos_historial (usuario_id, compra_id, tienda, external_id, periodo,
         cobrado_en, monto, moneda, estado)
       VALUES ($1, $2, 'google_play', $3, to_char(now(), 'YYYY-MM'), now() - interval '1 day', 99, 'MXN', 'pagado')`,
      [u.id, filas[0].id, orderId],
    );
    return filas[0].id;
  };

  const estadoDe = async (u: Usuario) => {
    const s = await suscripcionRepository.findOneByOrFail({ usuarioId: u.id });
    return { estado: s.estado, motivo: s.motivo, s };
  };
  const pagosDe = (
    u: Usuario,
  ): Promise<Array<{ external_id: string; estado: string }>> =>
    dataSource.query(
      'SELECT external_id, estado FROM pagos_historial WHERE usuario_id = $1 ORDER BY created_at, external_id',
      [u.id],
    );
  const evento = async (messageId: string) => {
    const filas: Array<{
      resultado: string | null;
      procesado_en: Date | null;
      error: string | null;
      tipo: string | null;
      payload: unknown;
    }> = await dataSource.query(
      'SELECT resultado, procesado_en, error, tipo, payload FROM eventos_tienda WHERE message_id = $1',
      [`${prefijoMsg}-${messageId}`],
    );
    return filas;
  };

  const login = async (u: Usuario): Promise<string> => {
    const res = await request(http())
      .post('/auth/login')
      .send({ email: u.email, password })
      .expect(200);
    return (res.body as { access_token: string }).access_token;
  };
  const crearProducto = async (u: Usuario): Promise<string> => {
    const p = await productoRepository.save(
      productoRepository.create({
        usuarioId: u.id,
        nombre: `Alimento ${u.id.slice(0, 8)} ${unico}`,
        precioVenta: 50,
      }),
    );
    productosCreados.push(p);
    return p.id;
  };

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(FUENTE_ESTADO_GOOGLE)
      .useValue(fuenteFalsa)
      .overrideProvider(VERIFICADOR_PUSH)
      .useValue(verificadorPushFalso)
      .compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    usuarioRepository = moduleFixture.get(getRepositoryToken(Usuario));
    suscripcionRepository = moduleFixture.get(getRepositoryToken(Suscripcion));
    productoRepository = moduleFixture.get(getRepositoryToken(Producto));
    ticketRepository = moduleFixture.get(getRepositoryToken(Ticket));
    cuentaOfuscada = moduleFixture.get(CuentaOfuscadaService);
    producto =
      moduleFixture.get<ConfigSuscripcion>(
        CONFIG_SUSCRIPCION,
      ).productoSuscripcionId;
  });

  afterAll(async () => {
    const ids = usuarios.map((u) => u.id);
    await dataSource.query(
      `DELETE FROM eventos_tienda WHERE message_id LIKE $1`,
      [`${prefijoMsg}-%`],
    );
    if (ids.length > 0) {
      await ticketRepository.delete(ids.map((id) => ({ usuarioId: id })));
      await productoRepository.delete(ids.map((id) => ({ usuarioId: id })));
      await usuarioRepository.delete(ids);
    }
    await app.close();
  });

  describe('flujo de renovación, cobro fallido y recuperación', () => {
    let a: Usuario;
    let tokenA: string;
    const tok = () => `tok-a-${unico}`;

    it('RENEWED: pago nuevo y acceso_hasta movido; el payload no guarda el token', async () => {
      a = await crearUsuario('a');
      await sembrarActiva(a, tok(), `GPA.A1-${unico}`, 1);
      tokenA = await login(a);
      const nuevoFin = enDias(31);
      responder(tok(), googleActivo('ACTIVE', nuevoFin, `GPA.A2-${unico}`));

      await enviar('a1', aviso(2, tok())).expect(200);

      const { estado, s } = await estadoDe(a);
      expect(estado).toBe('activa');
      expect(
        Math.abs((s.accesoHasta as Date).getTime() - nuevoFin.getTime()),
      ).toBeLessThan(1000);
      expect((await pagosDe(a)).map((p) => p.external_id)).toEqual([
        `GPA.A1-${unico}`,
        `GPA.A2-${unico}`,
      ]);
      const [ev] = await evento('a1');
      expect(ev.resultado).toBe('aplicado');
      expect(ev.procesado_en).not.toBeNull();
      expect(ev.tipo).toBe('SUBSCRIPTION_RENEWED');
      expect(JSON.stringify(ev.payload)).not.toContain(tok());
      expect(JSON.stringify(ev.payload)).toContain('sha256:');
    });

    it('el mismo messageId dos veces: un solo efecto y una sola fila', async () => {
      await enviar('a1', aviso(2, tok())).expect(200);
      expect(await pagosDe(a)).toHaveLength(2);
      expect(await evento('a1')).toHaveLength(1);
    });

    it('ON_HOLD: vencida/cobro_fallido y fila fallido; luego RECOVERED: activa con fallido y pagado', async () => {
      responder(
        tok(),
        googleActivo(
          'ON_HOLD',
          new Date(Date.now() - 3_600_000),
          `GPA.A2-${unico}`,
          {},
          false,
        ),
      );
      await enviar('a2', aviso(5, tok())).expect(200);
      const bloqueada = await estadoDe(a);
      expect(bloqueada.estado).toBe('vencida');
      expect(bloqueada.motivo).toBe('cobro_fallido');
      const fallidos = (await pagosDe(a)).filter((p) => p.estado === 'fallido');
      expect(fallidos).toHaveLength(1);
      expect(fallidos[0].external_id).toMatch(
        /^fallido-[0-9a-f-]{36}-\d{4}-\d{2}$/,
      );

      const snapshotBloqueado = await request(http())
        .get('/me/suscripcion')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      expect(snapshotBloqueado.body).toMatchObject({
        estado: 'vencida',
        motivo: 'cobro_fallido',
      });

      responder(tok(), googleActivo('ACTIVE', enDias(61), `GPA.A3-${unico}`));
      await enviar('a3', aviso(1, tok())).expect(200);

      const recuperada = await estadoDe(a);
      expect(recuperada.estado).toBe('activa');
      expect(recuperada.motivo).toBeNull();
      const estados = (await pagosDe(a)).map((p) => p.estado).sort();
      expect(estados).toEqual(['fallido', 'pagado', 'pagado', 'pagado']);

      const snapshot = await request(http())
        .get('/me/suscripcion')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      const cuerpo = snapshot.body as {
        estado: string;
        historial: Array<{ estado: string }>;
      };
      expect(cuerpo.estado).toBe('activa');
      expect(cuerpo.historial.map((h) => h.estado)).toEqual(
        expect.arrayContaining(['fallido', 'pagado']),
      );
    });
  });

  describe('cancelación, expiración y bloqueo (POST /tickets)', () => {
    let b: Usuario;
    let tokenB: string;
    let productoB: string;
    const tok = () => `tok-b-${unico}`;
    const ticket = () =>
      request(http())
        .post('/tickets')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ items: [{ producto_id: productoB, cantidad: 1 }] });

    it('CANCELED con expiry futuro: sigue trabajando (sin 403)', async () => {
      b = await crearUsuario('b');
      await sembrarActiva(b, tok(), `GPA.B1-${unico}`, 10);
      productoB = await crearProducto(b);
      tokenB = await login(b);
      const fin = enDias(10);
      responder(
        tok(),
        googleActivo('CANCELED', fin, `GPA.B1-${unico}`, {}, false),
      );
      await enviar('b1', aviso(3, tok())).expect(200);
      expect((await estadoDe(b)).estado).toBe('cancelada');
      await ticket().expect(201);
    });

    it('EXPIRED: vencida y POST /tickets responde 403', async () => {
      responder(
        tok(),
        googleActivo(
          'EXPIRED',
          new Date(Date.now() - 60_000),
          `GPA.B1-${unico}`,
          {},
          false,
        ),
      );
      await enviar('b2', aviso(13, tok())).expect(200);
      const r = await estadoDe(b);
      expect(r.estado).toBe('vencida');
      expect(r.motivo).toBe('cancelada');
      const res = await ticket().expect(403);
      expect((res.body as { message: string }).message).toContain(
        'SUSCRIPCION_REQUERIDA',
      );
    });
  });

  describe('reembolso (F3)', () => {
    it('voided con Google ACTIVE: vencida/reembolso, pago reembolsado y 403; un aviso sin pedido nuevo no lo revierte', async () => {
      const c = await crearUsuario('c');
      const tok = `tok-c-${unico}`;
      const orderId = `GPA.C1-${unico}`;
      await sembrarActiva(c, tok, orderId, 20);
      const productoC = await crearProducto(c);
      const tokenC = await login(c);
      responder(tok, googleActivo('ACTIVE', enDias(20), orderId));

      await enviar('c1', voided(tok, orderId)).expect(200);

      const r = await estadoDe(c);
      expect(r.estado).toBe('vencida');
      expect(r.motivo).toBe('reembolso');
      expect((await pagosDe(c))[0].estado).toBe('reembolsado');
      const res = await request(http())
        .post('/tickets')
        .set('Authorization', `Bearer ${tokenC}`)
        .send({ items: [{ producto_id: productoC, cantidad: 1 }] })
        .expect(403);
      expect((res.body as { message: string }).message).toContain(
        'SUSCRIPCION_REQUERIDA',
      );

      await enviar('c2', aviso(2, tok)).expect(200);
      expect((await estadoDe(c)).motivo).toBe('reembolso');

      responder(tok, googleActivo('ACTIVE', enDias(50), `GPA.C2-${unico}`));
      await enviar('c3', aviso(2, tok)).expect(200);
      expect((await estadoDe(c)).estado).toBe('activa');
    });
  });

  describe('orden invertido y avisos especiales', () => {
    it('EXPIRED antes que CANCELED: el estado final es coherente (siempre se re-consulta)', async () => {
      const d = await crearUsuario('d');
      const tok = `tok-d-${unico}`;
      await sembrarActiva(d, tok, `GPA.D1-${unico}`, 10);
      responder(
        tok,
        googleActivo(
          'EXPIRED',
          new Date(Date.now() - 60_000),
          `GPA.D1-${unico}`,
          {},
          false,
        ),
      );
      await enviar('d1', aviso(13, tok)).expect(200);
      await enviar('d2', aviso(3, tok)).expect(200);
      const r = await estadoDe(d);
      expect(r.estado).toBe('vencida');
      expect(r.motivo).toBe('cancelada');
    });

    it('token desconocido: 200 compra_desconocida', async () => {
      const tok = `tok-desconocido-${unico}`;
      responder(tok, googleActivo('ACTIVE', enDias(30), `GPA.X-${unico}`));
      await enviar('x1', aviso(4, tok)).expect(200);
      expect((await evento('x1'))[0].resultado).toBe('compra_desconocida');
    });

    it('testNotification: 200 prueba', async () => {
      await enviar(
        't1',
        b64({
          packageName: 'com.canales.ticket',
          testNotification: { version: '1.0' },
        }),
      ).expect(200);
      expect((await evento('t1'))[0].resultado).toBe('prueba');
    });

    it('data no decodificable: 200 mensaje_invalido', async () => {
      await enviar('i1', '%%%no-es-json').expect(200);
      const [ev] = await evento('i1');
      expect(ev.resultado).toBe('mensaje_invalido');
      expect(ev.payload).toEqual({ invalido: true });
    });
  });

  describe('compra fuera de la app (F5)', () => {
    it('con expiredPurchaseToken conocido: se liga, se aplica y se reconoce', async () => {
      const e = await crearUsuario('e');
      const viejo = `mock-compra-viejo-${unico}`;
      const nuevo = `mock-compra-nuevo-${unico}`;
      await sembrarActiva(e, viejo, `GPA.E1-${unico}`, 10);
      await dataSource.query(
        `UPDATE compras SET estado = 'expirada' WHERE usuario_id = $1`,
        [e.id],
      );
      await suscripcionRepository.update(
        { usuarioId: e.id },
        {
          estado: 'vencida',
          motivo: 'cancelada',
          accesoHasta: enDias(-2),
          proximoCobro: null,
          renovacionAutomatica: false,
        },
      );
      responder(
        nuevo,
        googleActivo('ACTIVE', enDias(30), `GPA.E2-${unico}`, {
          outOfAppPurchaseContext: { expiredPurchaseToken: viejo },
        }),
      );

      await enviar('e1', aviso(4, nuevo)).expect(200);

      const [ev] = await evento('e1');
      expect(ev.resultado).toBe('aplicado');
      expect((await estadoDe(e)).estado).toBe('activa');
      const compras: Array<{ estado: string; reconocida_en: Date | null }> =
        await dataSource.query(
          'SELECT estado, reconocida_en FROM compras WHERE usuario_id = $1 AND purchase_token = $2',
          [e.id, nuevo],
        );
      expect(compras).toHaveLength(1);
      expect(compras[0].estado).toBe('confirmada');
      expect(compras[0].reconocida_en).not.toBeNull();
    });
  });

  describe('errores del push', () => {
    it('OIDC inválido: 401 y SIN fila', async () => {
      await enviar('o1', aviso(2, 'x'), 'Bearer falso').expect(401);
      await enviar('o2', aviso(2, 'x'), null).expect(401);
      expect(await evento('o1')).toHaveLength(0);
      expect(await evento('o2')).toHaveLength(0);
    });

    it('sin messageId: 400', async () => {
      await enviar(null, aviso(2, 'x')).expect(400);
    });

    it('messageId de más de 100 caracteres: 400', async () => {
      await request(http())
        .post('/tienda/google/rtdn')
        .set('Authorization', 'Bearer valido')
        .send({ message: { data: aviso(2, 'x'), messageId: 'm'.repeat(101) } })
        .expect(400);
    });

    it('Google responde 503: 503, evento en error sin procesado_en; al reenviar con Google bien se aplica', async () => {
      const f = await crearUsuario('f');
      const tok = `tok-f-${unico}`;
      await sembrarActiva(f, tok, `GPA.F1-${unico}`, 1);
      respuestas.set(tok, () =>
        Promise.reject(Object.assign(new Error('caído'), { status: 503 })),
      );

      await enviar('f1', aviso(2, tok)).expect(503);
      const [fallido] = await evento('f1');
      expect(fallido.resultado).toBe('error');
      expect(fallido.procesado_en).toBeNull();
      expect(fallido.error).not.toContain(tok);

      responder(tok, googleActivo('ACTIVE', enDias(31), `GPA.F2-${unico}`));
      await enviar('f1', aviso(2, tok)).expect(200);
      const [ok] = await evento('f1');
      expect(ok.resultado).toBe('aplicado');
      expect(ok.procesado_en).not.toBeNull();
      expect(ok.error).toBeNull();
      expect(await pagosDe(f)).toHaveLength(2);
    });
  });

  describe('concurrencia', () => {
    it('dos mensajes distintos del mismo token en paralelo: un solo pago nuevo', async () => {
      const g = await crearUsuario('g');
      const tok = `tok-g-${unico}`;
      await sembrarActiva(g, tok, `GPA.G1-${unico}`, 1);
      responder(tok, googleActivo('ACTIVE', enDias(31), `GPA.G2-${unico}`));
      const [r1, r2] = await Promise.all([
        enviar('g1', aviso(2, tok)),
        enviar('g2', aviso(2, tok)),
      ]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(await pagosDe(g)).toHaveLength(2);
    });

    it('un aviso en paralelo con validar-compra del mismo token: una sola compra y un solo pago', async () => {
      const h = await crearUsuario('h');
      const tok = `mock-compra-par-${unico}`;
      // Cuenta sin días restantes para que la compra se aplique (D2 no interviene).
      await suscripcionRepository.update(
        { usuarioId: h.id },
        {
          pruebaInicio: new Date(Date.now() - 20 * dia),
          pruebaFin: new Date(Date.now() - 6 * dia),
        },
      );
      const tokenH = await login(h);
      // Mismo orderId que el verificador simulado, para que haya un solo pago.
      const orderSim = `SIM-${createHash('sha256').update(tok).digest('hex').slice(0, 24)}`;
      responder(
        tok,
        googleActivo('ACTIVE', enDias(30), orderSim, {
          externalAccountIdentifiers: {
            obfuscatedExternalAccountId: cuentaOfuscada.calcular(h.id),
          },
        }),
      );

      const [rtdn, validar] = await Promise.all([
        enviar('h1', aviso(4, tok)),
        request(http())
          .post('/me/suscripcion/validar-compra')
          .set('Authorization', `Bearer ${tokenH}`)
          .send({
            tienda: 'google_play',
            producto_id: producto,
            token_compra: tok,
          }),
      ]);
      expect(rtdn.status).toBe(200);
      expect(validar.status).toBe(200);
      const compras: Array<{ n: number }> = await dataSource.query(
        'SELECT count(*)::int AS n FROM compras WHERE purchase_token = $1',
        [tok],
      );
      expect(compras[0].n).toBe(1);
      expect(await pagosDe(h)).toHaveLength(1);
      expect((await estadoDe(h)).estado).toBe('activa');
    });
  });
});
