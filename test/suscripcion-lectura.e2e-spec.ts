import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { Usuario } from '../src/usuarios/entities/usuario.entity';
import { Suscripcion } from '../src/suscripciones/entities/suscripcion.entity';
import { PagoHistorial } from '../src/suscripciones/entities/pago-historial.entity';
import { SuscripcionesService } from '../src/suscripciones/suscripciones.service';

/**
 * Test de integración con Postgres real (nada mockeado): lectura del estado
 * de suscripción (etapa 2). Mismo patrón que forgot-password.e2e-spec.ts: el
 * usuario se inserta por repositorio (con hash bcrypt real para poder hacer
 * POST /auth/login) y se borra en `afterAll`; el ON DELETE CASCADE limpia su
 * suscripción y sus pagos. No se llama a POST /auth/register (throttle de 3
 * cada 30 minutos): ese camino queda cubierto por los unitarios.
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

type Snapshot = Record<string, unknown> & {
  estado: string;
  motivo: string | null;
  ahora_servidor: string;
  historial: Array<Record<string, unknown>>;
};

describe('GET /me/suscripcion y campo suscripcion en auth (e2e, Postgres real)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let usuarioRepository: Repository<Usuario>;
  let suscripcionRepository: Repository<Suscripcion>;
  let pagoRepository: Repository<PagoHistorial>;
  let usuario: Usuario;
  let token: string;
  const password = 'password1';
  const unico = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const email = `susc-lectura-${unico}@example.com`;

  const get = (path: string, auth = true) => {
    const req = request(app.getHttpServer()).get(path);
    return auth ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  const sinAhora = (s: Snapshot) => {
    const copia = { ...s };
    delete (copia as Partial<Snapshot>).ahora_servidor;
    return copia;
  };

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    usuarioRepository = moduleFixture.get(getRepositoryToken(Usuario));
    suscripcionRepository = moduleFixture.get(getRepositoryToken(Suscripcion));
    pagoRepository = moduleFixture.get(getRepositoryToken(PagoHistorial));

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

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    token = (login.body as { access_token: string }).access_token;
  });

  afterAll(async () => {
    await usuarioRepository.delete({ id: usuario.id });
    await app.close();
  });

  it('sin token responde 401', async () => {
    await get('/me/suscripcion', false).expect(401);
  });

  it('con token responde 200 con las 10 claves, estado prueba y sin historial', async () => {
    const res = await get('/me/suscripcion').expect(200);
    const body = res.body as Snapshot;

    expect(Object.keys(body).sort()).toEqual([...CLAVES_SNAPSHOT].sort());
    expect(body.estado).toBe('prueba');
    expect(body.motivo).toBeNull();
    expect(body.historial).toEqual([]);
    expect(body.ahora_servidor).toMatch(/-06:00$/);
  });

  it('con prueba_fin en el pasado pasa a prueba_vencida con motivo prueba_terminada', async () => {
    await suscripcionRepository
      .createQueryBuilder()
      .update()
      // CHK_suscripciones_prueba exige prueba_fin > prueba_inicio: se mueve
      // también el inicio para que la prueba quede vencida hace 1 hora.
      .set({
        pruebaInicio: () => "now() - interval '15 days'",
        pruebaFin: () => "now() - interval '1 hour'",
      })
      .where('usuario_id = :id', { id: usuario.id })
      .execute();

    const body = (await get('/me/suscripcion').expect(200)).body as Snapshot;

    expect(body.estado).toBe('prueba_vencida');
    expect(body.motivo).toBe('prueba_terminada');
  });

  it('devuelve el historial en orden descendente y con la forma correcta', async () => {
    const pagos: Array<
      [string, string, string, number, 'pagado' | 'reembolsado']
    > = [
      [`GPA.${unico}.1`, '2026-01', '2026-01-10T12:00:00Z', 49, 'pagado'],
      [`GPA.${unico}.3`, '2026-03', '2026-03-10T12:00:00Z', 49.5, 'pagado'],
      [`GPA.${unico}.2`, '2026-02', '2026-02-10T12:00:00Z', 49, 'reembolsado'],
    ];
    for (const [externalId, periodo, cobradoEn, monto, estado] of pagos) {
      await pagoRepository.save(
        pagoRepository.create({
          usuarioId: usuario.id,
          compraId: null,
          tienda: 'google_play',
          externalId,
          periodo,
          cobradoEn: new Date(cobradoEn),
          monto,
          moneda: 'MXN',
          estado,
        }),
      );
    }

    const body = (await get('/me/suscripcion').expect(200)).body as Snapshot;

    expect(body.historial.map((p) => p.id)).toEqual([
      `GPA.${unico}.3`,
      `GPA.${unico}.2`,
      `GPA.${unico}.1`,
    ]);
    expect(body.historial[0]).toEqual({
      id: `GPA.${unico}.3`,
      periodo: '2026-03',
      cobrado_en: '2026-03-10T06:00:00-06:00',
      monto: 49.5,
      moneda: 'MXN',
      estado: 'pagado',
    });
    expect(typeof body.historial[0].monto).toBe('number');
  });

  it('POST /auth/login y GET /me incluyen suscripcion igual a la de GET /me/suscripcion salvo ahora_servidor', async () => {
    const esperado = sinAhora(
      (await get('/me/suscripcion').expect(200)).body as Snapshot,
    );

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    const loginBody = login.body as {
      user: Record<string, unknown>;
      suscripcion: Snapshot;
    };
    expect(loginBody.user).not.toHaveProperty('suscripcion');
    expect(sinAhora(loginBody.suscripcion)).toEqual(esperado);

    const me = (await get('/me').expect(200)).body as {
      updated_at: string;
      suscripcion: Snapshot;
    };
    expect(me.updated_at).toBeDefined();
    expect(sinAhora(me.suscripcion)).toEqual(esperado);
  });
});
