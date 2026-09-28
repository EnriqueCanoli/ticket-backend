import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { MailService } from '../src/auth/mail.service';
import { Usuario } from '../src/usuarios/entities/usuario.entity';
import { PasswordResetToken } from '../src/auth/entities/password-reset-token.entity';

/**
 * Test de integración con Postgres real (no mockea repositorios/TypeORM):
 * reproduce BE-03 (condición de carrera en POST /auth/forgot-password que
 * podía dejar 2+ password_reset_tokens vigentes para el mismo usuario) y
 * confirma que, con el fix (transacción + `SELECT ... FOR UPDATE` sobre la
 * fila de `usuarios` en `AuthService.forgotPassword()`), 3 llamadas
 * concurrentes al endpoint para el mismo usuario dejan como máximo 1 fila
 * vigente.
 *
 * `MailService` se reemplaza por un stub (`overrideProvider`) para no
 * disparar envíos reales a Brevo con la API key de `.env` — el resto del
 * módulo (TypeOrmModule con la conexión real, guards, throttler, AuthService
 * real) se levanta tal cual en producción/desarrollo.
 *
 * El usuario de prueba se crea insertando directamente con el repositorio de
 * `Usuario` (no vía `POST /auth/register`) para no consumir el throttle de
 * registro (3 req/30min por IP) entre corridas, y se borra en `afterAll`
 * (el `ON DELETE CASCADE` de `password_reset_tokens.usuario_id` se encarga
 * de limpiar también sus tokens).
 */
describe('POST /auth/forgot-password — condición de carrera BE-03 (e2e, Postgres real)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let usuarioRepository: Repository<Usuario>;
  let passwordResetTokenRepository: Repository<PasswordResetToken>;
  let usuarioId: string;
  const email = `be03-e2e-${Date.now()}@example.com`;

  beforeAll(async () => {
    const mailServiceStub: Partial<MailService> = {
      sendPasswordResetCode: jest.fn().mockResolvedValue(undefined),
    };

    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MailService)
      .useValue(mailServiceStub)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    usuarioRepository = moduleFixture.get(getRepositoryToken(Usuario));
    passwordResetTokenRepository = moduleFixture.get(
      getRepositoryToken(PasswordResetToken),
    );

    const usuario = await usuarioRepository.save(
      usuarioRepository.create({
        email,
        passwordHash: 'no-se-usa-en-este-test',
        phone: String(
          Math.floor(1_000_000_000 + Math.random() * 8_999_999_999),
        ),
        pin: '0000',
        aceptoTerminos: true,
        tokenVersion: 0,
      }),
    );
    usuarioId = usuario.id;
  });

  afterAll(async () => {
    await usuarioRepository.delete({ id: usuarioId });
    await app.close();
  });

  it('deja como máximo 1 password_reset_token vigente tras 3 POST /auth/forgot-password concurrentes al mismo email', async () => {
    const server = app.getHttpServer();

    const responses = await Promise.all(
      [1, 2, 3].map(() =>
        request(server).post('/auth/forgot-password').send({ email }),
      ),
    );

    // Anti-enumeración: las 3 responden 200 con el mismo mensaje genérico,
    // nunca un 500 por violar el índice único (la transacción serializa las
    // 3 llamadas en vez de dejar que compitan).
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        message:
          'Si el correo está registrado, recibirás un código para restablecer tu contraseña.',
      });
    }

    const vigentes = await passwordResetTokenRepository.find({
      where: { usuarioId, usedAt: IsNull() },
    });

    expect(vigentes.length).toBe(1);
  }, 30000);
});
