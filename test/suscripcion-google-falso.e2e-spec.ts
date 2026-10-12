import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/main';
import { Usuario } from '../src/usuarios/entities/usuario.entity';
import { Suscripcion } from '../src/suscripciones/entities/suscripcion.entity';
import { SuscripcionesService } from '../src/suscripciones/suscripciones.service';
import { CONFIG_SUSCRIPCION } from '../src/suscripciones/config-suscripcion';
import type { ConfigSuscripcion } from '../src/suscripciones/config-suscripcion';
import { CuentaOfuscadaService } from '../src/suscripciones/cuenta-ofuscada';
import { VERIFICADOR_TIENDA } from '../src/suscripciones/verificadores/verificador-tienda.interface';
import { VerificadorGoogle } from '../src/suscripciones/verificadores/verificador-google';
import type {
  GooglePlayApi,
  SuscripcionGoogle,
} from '../src/suscripciones/verificadores/google-play-api';

/**
 * Etapa 4b: `VerificadorGoogle` sobre una `GooglePlayApi` FALSA (nunca se
 * llama a Google) con Postgres real. Comprueba el 409 por HMAC ajeno, una
 * compra activa sin renovación y TIENDA_NO_DISPONIBLE sin tocar la BD.
 */
describe('Compra con VerificadorGoogle y API falsa (etapa 4b, e2e, Postgres real)', () => {
  let app: NestExpressApplication;
  let moduleFixture: TestingModule;
  let dataSource: DataSource;
  let usuarioRepository: Repository<Usuario>;
  let usuario: Usuario;
  let token: string;
  let producto: string;
  let cuentaPropia: string;
  const password = 'password1';
  const unico = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const email = `susc-4b-google-${unico}@example.com`;
  const unMes = new Date(Date.now() + 30 * 86_400_000).toISOString();

  const respuesta: { actual: () => Promise<SuscripcionGoogle> } = {
    actual: () => Promise.reject(new Error('sin configurar')),
  };
  const apiFalsa: GooglePlayApi = {
    obtenerSuscripcion: () => respuesta.actual(),
    reconocer: () => Promise.resolve(),
    obtenerPedido: () =>
      Promise.resolve({
        total: { currencyCode: 'MXN', units: '129', nanos: 500_000_000 },
      }),
  };

  const http = () => app.getHttpServer() as App;
  const validar = (tokenCompra: string) =>
    request(http())
      .post('/me/suscripcion/validar-compra')
      .set('Authorization', `Bearer ${token}`)
      .send({
        tienda: 'google_play',
        producto_id: producto,
        token_compra: tokenCompra,
      });
  const compra = (
    estado: string,
    cuenta: string | null,
    extra: Partial<SuscripcionGoogle> = {},
  ): SuscripcionGoogle => ({
    subscriptionState: estado,
    startTime: new Date().toISOString(),
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    ...(cuenta
      ? { externalAccountIdentifiers: { obfuscatedExternalAccountId: cuenta } }
      : {}),
    lineItems: [
      {
        productId: producto,
        expiryTime: unMes,
        latestSuccessfulOrderId: `GPA.E2E-${unico}`,
        autoRenewingPlan: { autoRenewEnabled: false },
      },
    ],
    ...extra,
  });

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(VERIFICADOR_TIENDA)
      .useValue(new VerificadorGoogle(apiFalsa))
      .compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    usuarioRepository = moduleFixture.get(getRepositoryToken(Usuario));
    const suscripcionRepository: Repository<Suscripcion> = moduleFixture.get(
      getRepositoryToken(Suscripcion),
    );
    producto =
      moduleFixture.get<ConfigSuscripcion>(
        CONFIG_SUSCRIPCION,
      ).productoSuscripcionId;

    usuario = await usuarioRepository.save(
      usuarioRepository.create({
        email,
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
      .crearPrueba(usuario.id, usuario.createdAt);
    // Prueba vencida: sin días restantes.
    await suscripcionRepository.update(
      { usuarioId: usuario.id },
      {
        pruebaInicio: new Date(Date.now() - 15 * 86_400_000),
        pruebaFin: new Date(Date.now() - 3_600_000),
      },
    );
    cuentaPropia = moduleFixture
      .get(CuentaOfuscadaService)
      .calcular(usuario.id);

    const login = await request(http())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    token = (login.body as { access_token: string }).access_token;
  });

  afterAll(async () => {
    await usuarioRepository.delete({ id: usuario.id });
    await app.close();
  });

  const contarCompras = async (): Promise<number> => {
    const filas: Array<{ n: number }> = await dataSource.query(
      'SELECT count(*)::int AS n FROM compras WHERE usuario_id = $1',
      [usuario.id],
    );
    return filas[0].n;
  };

  it('cuenta ofuscada ajena: 409 TIENDA_EN_USO y no se registra nada', async () => {
    respuesta.actual = () =>
      Promise.resolve(compra('SUBSCRIPTION_STATE_ACTIVE', 'a'.repeat(64)));
    const res = await validar(`token-ajeno-${unico}`).expect(409);
    expect((res.body as { message: string }).message).toContain(
      'TIENDA_EN_USO',
    );
    expect(await contarCompras()).toBe(0);
  });

  it('Google no disponible: 503 TIENDA_NO_DISPONIBLE sin tocar la BD', async () => {
    respuesta.actual = () =>
      Promise.reject(Object.assign(new Error('caído'), { status: 503 }));
    const res = await validar(`token-caido-${unico}`).expect(503);
    expect((res.body as { message: string }).message).toContain(
      'TIENDA_NO_DISPONIBLE',
    );
    expect(await contarCompras()).toBe(0);
  });

  it('cuenta propia, cancelada con tiempo restante: activa sin renovación ni próximo cobro', async () => {
    respuesta.actual = () =>
      Promise.resolve(compra('SUBSCRIPTION_STATE_CANCELED', cuentaPropia));
    const res = await validar(`token-propio-${unico}`).expect(200);
    const snapshot = res.body as {
      estado: string;
      renovacion_automatica: boolean;
      proximo_cobro: string | null;
      acceso_hasta: string | null;
      historial: Array<{ monto: number | string }>;
    };
    expect(snapshot.estado).toBe('activa');
    expect(snapshot.renovacion_automatica).toBe(false);
    expect(snapshot.proximo_cobro).toBeNull();
    expect(snapshot.acceso_hasta).not.toBeNull();
    expect(Number(snapshot.historial[0].monto)).toBe(129.5);
    expect(await contarCompras()).toBe(1);
  });
});
