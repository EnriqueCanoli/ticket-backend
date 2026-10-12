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

/**
 * Etapa 4a: errores de POST /me/suscripcion/validar-compra (Postgres real,
 * `configureApp(app)`). Suite aparte de `suscripcion-compra.e2e-spec.ts` para
 * no pasar de 10 llamadas al endpoint por suite (throttle de 10 por minuto).
 * Un usuario creado por repositorio y un solo login.
 */
describe('Compra de suscripción, errores (etapa 4a, e2e, Postgres real)', () => {
  let app: NestExpressApplication;
  let moduleFixture: TestingModule;
  let dataSource: DataSource;
  let usuarioRepository: Repository<Usuario>;
  let usuario: Usuario;
  let token: string;
  let productoSuscripcionId: string;
  const password = 'password1';
  const unico = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const email = `susc-4a-errores-${unico}@example.com`;

  const http = () => app.getHttpServer() as App;
  const post = () =>
    request(http())
      .post('/me/suscripcion/validar-compra')
      .set('Authorization', `Bearer ${token}`);
  const valido = () => ({
    tienda: 'google_play',
    producto_id: productoSuscripcionId,
    token_compra: `mock-compra-errores-${unico}`,
  });

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    usuarioRepository = moduleFixture.get(getRepositoryToken(Usuario));
    const suscripcionRepository: Repository<Suscripcion> = moduleFixture.get(
      getRepositoryToken(Suscripcion),
    );
    productoSuscripcionId =
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
    await suscripcionRepository.update(
      { usuarioId: usuario.id },
      {
        estado: 'prueba',
        pruebaInicio: new Date(Date.now() - 15 * 86_400_000),
        pruebaFin: new Date(Date.now() - 3_600_000),
      },
    );
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

  const sinEfecto = async () => {
    const compras = await dataSource.query<unknown[]>(
      'SELECT 1 FROM compras WHERE usuario_id = $1',
      [usuario.id],
    );
    expect(compras).toHaveLength(0);
  };

  it('mock-tienda-en-uso-x: 409 TIENDA_EN_USO', async () => {
    const res = await post()
      .send({ ...valido(), token_compra: 'mock-tienda-en-uso-x' })
      .expect(409);
    expect(JSON.stringify(res.body)).toContain('TIENDA_EN_USO');
    await sinEfecto();
  });

  it('token desconocido (basura): 400 COMPRA_RECHAZADA', async () => {
    const res = await post()
      .send({ ...valido(), token_compra: 'basura' })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('COMPRA_RECHAZADA');
    await sinEfecto();
  });

  it('producto distinto: 400 PRODUCTO_INVALIDO', async () => {
    const res = await post()
      .send({ ...valido(), producto_id: 'otro_producto' })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('PRODUCTO_INVALIDO');
    await sinEfecto();
  });

  it('un campo extra: 400', async () => {
    await post()
      .send({ ...valido(), extra: 1 })
      .expect(400);
  });

  it('tienda app_store: 400', async () => {
    await post()
      .send({ ...valido(), tienda: 'app_store' })
      .expect(400);
  });

  it('sin token_compra: 400', async () => {
    const { token_compra: _omitido, ...sinToken } = valido();
    void _omitido;
    await post().send(sinToken).expect(400);
  });

  it('sin Authorization: 401', async () => {
    await request(http())
      .post('/me/suscripcion/validar-compra')
      .send(valido())
      .expect(401);
  });
});
