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
 * Etapa 4a: POST /me/suscripcion/restaurar con el verificador simulado
 * (Postgres real, `configureApp(app)`). Dos usuarios creados por repositorio
 * (sin POST /auth/register), 2 logins y menos de 10 llamadas al endpoint.
 */
describe('Compra de suscripción, restaurar (etapa 4a, e2e, Postgres real)', () => {
  let app: NestExpressApplication;
  let moduleFixture: TestingModule;
  let dataSource: DataSource;
  let usuarioRepository: Repository<Usuario>;
  let productoSuscripcionId: string;
  const password = 'password1';
  const unico = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const cuentas: Record<'A' | 'B', { usuario: Usuario; token: string }> =
    {} as never;

  const http = () => app.getHttpServer() as App;
  const restaurar = (cuenta: 'A' | 'B', body: unknown) =>
    request(http())
      .post('/me/suscripcion/restaurar')
      .set('Authorization', `Bearer ${cuentas[cuenta].token}`)
      .send(body as object);
  const compra = (token_compra: string) => ({
    producto_id: productoSuscripcionId,
    token_compra,
  });
  const cuerpo = (...tokens: string[]) => ({
    tienda: 'google_play',
    compras: tokens.map(compra),
  });
  const estado = (res: request.Response) =>
    (res.body as { estado: string }).estado;
  const contar = async (tabla: 'compras' | 'pagos_historial', id: string) =>
    (
      await dataSource.query<unknown[]>(
        `SELECT 1 FROM "${tabla}" WHERE "usuario_id" = $1`,
        [id],
      )
    ).length;

  const crearCuenta = async (nombre: 'A' | 'B') => {
    const email = `susc-4a-restaurar-${nombre.toLowerCase()}-${unico}@example.com`;
    const usuario = await usuarioRepository.save(
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
    const suscripcionRepository: Repository<Suscripcion> = moduleFixture.get(
      getRepositoryToken(Suscripcion),
    );
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
    cuentas[nombre] = {
      usuario,
      token: (login.body as { access_token: string }).access_token,
    };
  };

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    usuarioRepository = moduleFixture.get(getRepositoryToken(Usuario));
    productoSuscripcionId =
      moduleFixture.get<ConfigSuscripcion>(
        CONFIG_SUSCRIPCION,
      ).productoSuscripcionId;
    await crearCuenta('A');
    await crearCuenta('B');
  });

  afterAll(async () => {
    for (const { usuario } of Object.values(cuentas)) {
      await usuarioRepository.delete({ id: usuario.id });
    }
    await app.close();
  });

  const tokenA = () => `mock-compra-restaurar-A-${unico}`;

  it('una compra propia válida: activa', async () => {
    const res = await restaurar('A', cuerpo(tokenA())).expect(200);
    expect(estado(res)).toBe('activa');
    expect(await contar('compras', cuentas.A.usuario.id)).toBe(1);
    expect(await contar('pagos_historial', cuentas.A.usuario.id)).toBe(1);
  });

  it('la misma otra vez: idempotente', async () => {
    const res = await restaurar('A', cuerpo(tokenA())).expect(200);
    expect(estado(res)).toBe('activa');
    expect(await contar('compras', cuentas.A.usuario.id)).toBe(1);
    expect(await contar('pagos_historial', cuentas.A.usuario.id)).toBe(1);
  });

  it('solo inválidas: 200 sin cambios', async () => {
    const res = await restaurar('B', cuerpo('basura-1', 'basura-2')).expect(
      200,
    );
    expect(estado(res)).toBe('prueba_vencida');
    expect(await contar('compras', cuentas.B.usuario.id)).toBe(0);
  });

  it('solo una ajena: 409 TIENDA_EN_USO', async () => {
    const res = await restaurar('B', cuerpo(tokenA())).expect(409);
    expect(JSON.stringify(res.body)).toContain('TIENDA_EN_USO');
  });

  it('propia más ajena: 200 y queda activa', async () => {
    const res = await restaurar(
      'B',
      cuerpo(tokenA(), `mock-compra-restaurar-B-${unico}`),
    ).expect(200);
    expect(estado(res)).toBe('activa');
    expect(await contar('compras', cuentas.B.usuario.id)).toBe(1);
  });

  it('compras: ["x"] da 400', async () => {
    await restaurar('A', { tienda: 'google_play', compras: ['x'] }).expect(400);
  });

  it('un elemento con campo extra da 400', async () => {
    await restaurar('A', {
      tienda: 'google_play',
      compras: [{ ...compra('mock-compra-extra'), extra: 1 }],
    }).expect(400);
  });

  it('11 elementos dan 400', async () => {
    const tokens = Array.from({ length: 11 }, (_, i) => `mock-compra-n-${i}`);
    await restaurar('A', cuerpo(...tokens)).expect(400);
  });

  it('arreglo vacío: 200 con el snapshot actual', async () => {
    const res = await restaurar('A', cuerpo()).expect(200);
    expect(estado(res)).toBe('activa');
  });
});
