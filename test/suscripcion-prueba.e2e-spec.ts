import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { Usuario } from '../src/usuarios/entities/usuario.entity';
import { Suscripcion } from '../src/suscripciones/entities/suscripcion.entity';
import { SuscripcionesService } from '../src/suscripciones/suscripciones.service';
import { aIsoNegocio, finDePrueba } from '../src/suscripciones/fechas';

/**
 * Test de integración con Postgres real (nada mockeado): la prueba de 14 días
 * de la suscripción (etapa 1). Sigue el patrón de forgot-password.e2e-spec.ts:
 * el usuario se inserta por repositorio (no vía POST /auth/register, para no
 * consumir el throttle de registro) y se borra en `afterAll` (el ON DELETE
 * CASCADE de `suscripciones.usuario_id` limpia su fila).
 */
describe('Suscripción — prueba de 14 días (e2e, Postgres real)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let usuarioRepository: Repository<Usuario>;
  let suscripcionRepository: Repository<Suscripcion>;
  let dataSource: DataSource;
  let service: SuscripcionesService;
  let usuario: Usuario;

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    usuarioRepository = moduleFixture.get(getRepositoryToken(Usuario));
    suscripcionRepository = moduleFixture.get(getRepositoryToken(Suscripcion));
    dataSource = moduleFixture.get(DataSource);
    service = moduleFixture.get(SuscripcionesService);

    usuario = await usuarioRepository.save(
      usuarioRepository.create({
        email: `susc-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`,
        passwordHash: 'no-se-usa-en-este-test',
        phone: String(
          Math.floor(1_000_000_000 + Math.random() * 8_999_999_999),
        ),
        pin: '0000',
        aceptoTerminos: true,
        tokenVersion: 0,
      }),
    );
  });

  afterAll(async () => {
    await usuarioRepository.delete({ id: usuario.id });
    await app.close();
  });

  it('crearPrueba dos veces deja una sola fila', async () => {
    await service.crearPrueba(usuario.id, usuario.createdAt);
    await service.crearPrueba(usuario.id, usuario.createdAt);

    const filas = await suscripcionRepository.find({
      where: { usuarioId: usuario.id },
    });
    expect(filas).toHaveLength(1);
    expect(filas[0].estado).toBe('prueba');
  });

  it('prueba_fin es finDePrueba(prueba_inicio) y cae a las 23:59:59 del día 14 en America/Mexico_City', async () => {
    const fila = await suscripcionRepository.findOneByOrFail({
      usuarioId: usuario.id,
    });

    expect(fila.pruebaFin.getTime()).toBe(
      finDePrueba(fila.pruebaInicio).getTime(),
    );

    const [{ dias, hora }] = await dataSource.query<
      { dias: number; hora: string }[]
    >(
      `SELECT
         ((prueba_fin AT TIME ZONE 'America/Mexico_City')::date
           - (prueba_inicio AT TIME ZONE 'America/Mexico_City')::date) AS dias,
         to_char(prueba_fin AT TIME ZONE 'America/Mexico_City', 'HH24:MI:SS') AS hora
       FROM suscripciones WHERE usuario_id = $1`,
      [usuario.id],
    );

    // Día de inicio + 13 días, a las 23:59:59.
    expect(Number(dias)).toBe(13);
    expect(hora).toBe('23:59:59');
  });

  it('la fórmula SQL de la migración de datos coincide con finDePrueba() para una fecha fija', async () => {
    const inicio = new Date('2026-03-03T09:12:00-06:00');

    const [{ fin }] = await dataSource.query<{ fin: Date }[]>(
      `SELECT (date_trunc('day', $1::timestamptz AT TIME ZONE 'America/Mexico_City')
                + interval '14 days' - interval '1 second') AT TIME ZONE 'America/Mexico_City' AS fin`,
      [inicio],
    );

    expect(new Date(fin).getTime()).toBe(finDePrueba(inicio).getTime());
    expect(aIsoNegocio(finDePrueba(inicio))).toBe('2026-03-16T23:59:59-06:00');
  });

  it('snapshot() devuelve estado "prueba" con los 10 campos', async () => {
    const snap = await service.snapshot(usuario);

    expect(snap.estado).toBe('prueba');
    expect(snap.motivo).toBeNull();
    expect(snap.historial).toEqual([]);
    expect(Object.keys(snap)).toHaveLength(10);
    expect(snap.ahora_servidor).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-06:00$/,
    );
  });
});
