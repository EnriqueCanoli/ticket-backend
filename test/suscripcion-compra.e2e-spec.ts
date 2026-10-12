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
import { Producto } from '../src/productos/entities/producto.entity';
import { Ticket } from '../src/tickets/entities/ticket.entity';
import { SuscripcionesService } from '../src/suscripciones/suscripciones.service';
import { CONFIG_SUSCRIPCION } from '../src/suscripciones/config-suscripcion';
import type { ConfigSuscripcion } from '../src/suscripciones/config-suscripcion';

/**
 * Etapa 4a: POST /me/suscripcion/validar-compra con el verificador simulado
 * (Postgres real y `configureApp(app)`). Usuarios creados por repositorio
 * (sin POST /auth/register) y 3 logins. Los casos de error de validación del
 * body van en `suscripcion-compra-errores.e2e-spec.ts` para no pasar de 10
 * llamadas por endpoint en cada suite (throttle de 10 por minuto).
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

interface Snapshot {
  estado: string;
  acceso_hasta: string | null;
  proximo_cobro: string | null;
  renovacion_automatica: boolean;
  tienda: string | null;
  historial: Array<{
    id: string;
    monto: number;
    moneda: string;
    estado: string;
  }>;
}

describe('Compra de suscripción, validar-compra (etapa 4a, e2e, Postgres real)', () => {
  let app: NestExpressApplication;
  let moduleFixture: TestingModule;
  let dataSource: DataSource;
  let usuarioRepository: Repository<Usuario>;
  let suscripcionRepository: Repository<Suscripcion>;
  let productoRepository: Repository<Producto>;
  let ticketRepository: Repository<Ticket>;
  let productoSuscripcionId: string;
  const password = 'password1';
  const unico = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const cuentas: Record<'A' | 'B' | 'C', { usuario: Usuario; token: string }> =
    {} as never;

  const http = () => app.getHttpServer() as App;
  const validar = (cuenta: 'A' | 'B' | 'C', token: string) =>
    request(http())
      .post('/me/suscripcion/validar-compra')
      .set('Authorization', `Bearer ${cuentas[cuenta].token}`)
      .send({
        tienda: 'google_play',
        producto_id: productoSuscripcionId,
        token_compra: token,
      });
  const accesoHastaDeA = async (): Promise<Date> => {
    const filas = await dataSource.query<Array<{ acceso_hasta: Date }>>(
      'SELECT acceso_hasta FROM suscripciones WHERE usuario_id = $1',
      [cuentas.A.usuario.id],
    );
    return filas[0].acceso_hasta;
  };
  const horas = (h: number) => new Date(Date.now() + h * 3_600_000);
  const dias = (d: number) => horas(d * 24);
  const filasDe = async (
    tabla: 'compras' | 'pagos_historial',
    usuarioId: string,
  ) =>
    await dataSource.query<Array<Record<string, unknown>>>(
      `SELECT * FROM "${tabla}" WHERE "usuario_id" = $1`,
      [usuarioId],
    );

  const crearCuenta = async (
    nombre: 'A' | 'B' | 'C',
    suscripcion: Partial<Suscripcion>,
  ) => {
    const email = `susc-4a-compra-${nombre.toLowerCase()}-${unico}@example.com`;
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
    await suscripcionRepository.update({ usuarioId: usuario.id }, suscripcion);
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
    suscripcionRepository = moduleFixture.get(getRepositoryToken(Suscripcion));
    productoRepository = moduleFixture.get(getRepositoryToken(Producto));
    ticketRepository = moduleFixture.get(getRepositoryToken(Ticket));
    productoSuscripcionId =
      moduleFixture.get<ConfigSuscripcion>(
        CONFIG_SUSCRIPCION,
      ).productoSuscripcionId;

    // A: prueba vencida. B: día 10 de la prueba (vigente). C: prueba vencida.
    const vencida = {
      estado: 'prueba' as const,
      pruebaInicio: dias(-15),
      pruebaFin: horas(-1),
    };
    await crearCuenta('A', vencida);
    await crearCuenta('B', {
      estado: 'prueba',
      pruebaInicio: dias(-10),
      pruebaFin: dias(4),
    });
    await crearCuenta('C', vencida);
  });

  afterAll(async () => {
    const ids = Object.values(cuentas).map((c) => c.usuario.id);
    for (const id of ids) {
      // No hay CASCADE desde usuarios hacia tickets ni productos.
      await ticketRepository.delete({ usuarioId: id });
      await productoRepository.delete({ usuarioId: id });
      // suscripciones, compras y pagos_historial caen en cascada.
      await usuarioRepository.delete({ id });
    }
    await app.close();
  });

  const tokenA1 = () => `mock-compra-A-1-${unico}`;

  it('a) cuenta bloqueada paga: 200 activa con las 10 claves, +1 mes y un pago de 99', async () => {
    const antes = Date.now();
    const res = await validar('A', tokenA1()).expect(200);
    const snap = res.body as Snapshot;

    expect(Object.keys(snap).sort()).toEqual([...CLAVES_SNAPSHOT].sort());
    expect(snap.estado).toBe('activa');
    expect(snap.renovacion_automatica).toBe(true);
    expect(snap.tienda).toBe('google_play');
    expect(snap.proximo_cobro).toBe(snap.acceso_hasta);
    const diasHasta =
      (new Date(snap.acceso_hasta as string).getTime() - antes) / 86_400_000;
    expect(diasHasta).toBeGreaterThan(27.9);
    expect(diasHasta).toBeLessThan(31.1);
    expect(snap.historial).toHaveLength(1);
    expect(snap.historial[0]).toMatchObject({
      monto: 99,
      moneda: 'MXN',
      estado: 'pagado',
    });

    // La cuenta que estaba bloqueada ya puede escribir.
    await request(http())
      .post('/productos')
      .set('Authorization', `Bearer ${cuentas.A.token}`)
      .send({ nombre: `Producto 4a ${unico}`, precio_venta: 10 })
      .expect(201);

    const compras = await filasDe('compras', cuentas.A.usuario.id);
    expect(compras).toHaveLength(1);
    expect(compras[0].estado).toBe('confirmada');
    expect(compras[0].reconocida_en).not.toBeNull();
  });

  it('b) el mismo token otra vez: mismo estado, 1 compra y 1 pago', async () => {
    const res = await validar('A', tokenA1()).expect(200);
    expect((res.body as Snapshot).estado).toBe('activa');
    expect(await filasDe('compras', cuentas.A.usuario.id)).toHaveLength(1);
    expect(await filasDe('pagos_historial', cuentas.A.usuario.id)).toHaveLength(
      1,
    );
  });

  it('c) D2: token nuevo con la cuenta activa: 200 sin cambios, 1 compra y 1 pago', async () => {
    const antes = await accesoHastaDeA();

    const res = await validar('A', `mock-compra-A-2-${unico}`).expect(200);
    expect((res.body as Snapshot).estado).toBe('activa');

    const despues = await accesoHastaDeA();
    expect(despues).toEqual(antes);
    expect(await filasDe('compras', cuentas.A.usuario.id)).toHaveLength(1);
    expect(await filasDe('pagos_historial', cuentas.A.usuario.id)).toHaveLength(
      1,
    );
  });

  it('d) la cuenta B con el token de A: 409 TIENDA_EN_USO', async () => {
    const res = await validar('B', tokenA1()).expect(409);
    expect(JSON.stringify(res.body)).toContain('TIENDA_EN_USO');
    expect(await filasDe('compras', cuentas.B.usuario.id)).toHaveLength(0);
  });

  it('e) D1: pendiente con la prueba vigente: sigue en prueba y guarda la compra pendiente', async () => {
    const res = await validar('B', `mock-pendiente-B-1-${unico}`).expect(200);
    expect((res.body as Snapshot).estado).toBe('prueba');

    const compras = await filasDe('compras', cuentas.B.usuario.id);
    expect(compras).toHaveLength(1);
    expect(compras[0].estado).toBe('pendiente');
    expect(await filasDe('pagos_historial', cuentas.B.usuario.id)).toHaveLength(
      0,
    );
  });

  it('f) D1: pendiente con la prueba vencida: pago_en_proceso y sin pagos', async () => {
    const res = await validar('C', `mock-pendiente-C-1-${unico}`).expect(200);
    const snap = res.body as Snapshot;
    expect(snap.estado).toBe('pago_en_proceso');
    expect(snap.tienda).toBe('google_play');
    expect(snap.historial).toHaveLength(0);
    expect(await filasDe('pagos_historial', cuentas.C.usuario.id)).toHaveLength(
      0,
    );
  });

  it('g) concurrencia: el mismo token nuevo desde dos cuentas da un 200 y un 409 y una sola compra', async () => {
    const token = `mock-compra-concurrente-${unico}`;
    const [rb, rc] = await Promise.all([
      validar('B', token),
      validar('C', token),
    ]);

    expect([rb.status, rc.status].sort()).toEqual([200, 409]);
    const perdedora = rb.status === 409 ? rb : rc;
    expect(JSON.stringify(perdedora.body)).toContain('TIENDA_EN_USO');

    const filas = await dataSource.query<unknown[]>(
      'SELECT usuario_id FROM compras WHERE purchase_token = $1',
      [token],
    );
    expect(filas).toHaveLength(1);
  });
});
