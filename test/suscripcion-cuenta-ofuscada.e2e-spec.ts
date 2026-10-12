import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/main';
import { Usuario } from '../src/usuarios/entities/usuario.entity';
import { SuscripcionesService } from '../src/suscripciones/suscripciones.service';

/**
 * Etapa 4b: `cuenta_ofuscada` en GET /me (Postgres real, modo simulado).
 * Dos usuarios creados por repositorio y un login cada uno (el login tiene
 * throttle de 5 por minuto).
 */
describe('GET /me: cuenta_ofuscada (etapa 4b, e2e, Postgres real)', () => {
  let app: NestExpressApplication;
  let moduleFixture: TestingModule;
  let usuarioRepository: Repository<Usuario>;
  const usuarios: Usuario[] = [];
  const tokens: string[] = [];
  const password = 'password1';
  const unico = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  const http = () => app.getHttpServer() as App;
  const me = async (indice: number) =>
    (
      await request(http())
        .get('/me')
        .set('Authorization', `Bearer ${tokens[indice]}`)
        .expect(200)
    ).body as { cuenta_ofuscada?: string; id: string };

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    usuarioRepository = moduleFixture.get(getRepositoryToken(Usuario));

    for (const sufijo of ['a', 'b']) {
      const email = `susc-4b-ofuscada-${sufijo}-${unico}@example.com`;
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
      usuarios.push(usuario);
      const login = await request(http())
        .post('/auth/login')
        .send({ email, password })
        .expect(200);
      tokens.push((login.body as { access_token: string }).access_token);
    }
  });

  afterAll(async () => {
    for (const usuario of usuarios) {
      await usuarioRepository.delete({ id: usuario.id });
    }
    await app.close();
  });

  it('devuelve 64 caracteres hexadecimales, estable entre llamadas', async () => {
    const primera = await me(0);
    const segunda = await me(0);
    expect(primera.cuenta_ofuscada).toMatch(/^[0-9a-f]{64}$/);
    expect(segunda.cuenta_ofuscada).toBe(primera.cuenta_ofuscada);
    expect(primera.cuenta_ofuscada).not.toContain(primera.id);
  });

  it('es distinta entre dos cuentas', async () => {
    const a = await me(0);
    const b = await me(1);
    expect(a.cuenta_ofuscada).not.toBe(b.cuenta_ofuscada);
  });

  it('no aparece en login', async () => {
    const login = await request(http())
      .post('/auth/login')
      .send({
        email: usuarios[0].email,
        password,
      })
      .expect(200);
    const cuerpo = login.body as { user: object };
    expect(cuerpo.user).not.toHaveProperty('cuenta_ofuscada');
    expect(cuerpo).not.toHaveProperty('cuenta_ofuscada');
  });
});
