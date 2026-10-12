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
import { Suscripcion } from '../src/suscripciones/entities/suscripcion.entity';
import { Producto } from '../src/productos/entities/producto.entity';
import { Ticket } from '../src/tickets/entities/ticket.entity';
import { SuscripcionesService } from '../src/suscripciones/suscripciones.service';

/**
 * Etapa 3: bloqueo en el servidor (Postgres real). POST /tickets y
 * POST/PATCH/DELETE /productos responden 403 SUSCRIPCION_REQUERIDA con el
 * estado efectivo prueba_vencida, vencida o pago_en_proceso; las lecturas no
 * se bloquean. Se usa `configureApp(app)` para que corra el ValidationPipe
 * real. Un solo login (throttle global de 60 requests por minuto).
 */
const BLOQUEO = {
  statusCode: 403,
  message: 'SUSCRIPCION_REQUERIDA: tu suscripción no está activa',
  error: 'Forbidden',
};

describe('Bloqueo por suscripción (etapa 3, e2e, Postgres real)', () => {
  let app: NestExpressApplication;
  let moduleFixture: TestingModule;
  let usuarioRepository: Repository<Usuario>;
  let suscripcionRepository: Repository<Suscripcion>;
  let productoRepository: Repository<Producto>;
  let ticketRepository: Repository<Ticket>;
  let usuario: Usuario;
  let productoId: string;
  let productoAuxId: string;
  let token: string;
  const password = 'password1';
  const unico = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const email = `susc-bloqueo-${unico}@example.com`;

  const http = () => app.getHttpServer() as App;
  const auth = (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);
  const ticketBody = () => ({
    items: [{ producto_id: productoId, cantidad: 1 }],
  });
  const postTicket = (body: object = ticketBody()) =>
    auth(request(http()).post('/tickets')).send(body);

  /** Cambia la fila de suscripción; el CHECK exige prueba_fin > prueba_inicio. */
  const fijarSuscripcion = async (parcial: Partial<Suscripcion>) => {
    await suscripcionRepository.update({ usuarioId: usuario.id }, parcial);
  };
  const horas = (h: number) => new Date(Date.now() + h * 3_600_000);
  const dias = (d: number) => horas(d * 24);
  const pruebaVencida = () => ({
    estado: 'prueba' as const,
    pruebaInicio: dias(-15),
    pruebaFin: horas(-1),
  });
  const pruebaVigente = () => ({
    estado: 'prueba' as const,
    pruebaInicio: dias(-1),
    pruebaFin: dias(13),
  });

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();

    usuarioRepository = moduleFixture.get(getRepositoryToken(Usuario));
    suscripcionRepository = moduleFixture.get(getRepositoryToken(Suscripcion));
    productoRepository = moduleFixture.get(getRepositoryToken(Producto));
    ticketRepository = moduleFixture.get(getRepositoryToken(Ticket));

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

    const [p1, p2] = await productoRepository.save([
      productoRepository.create({
        usuarioId: usuario.id,
        nombre: `Alimento ${unico}`,
        precioVenta: 50,
      }),
      productoRepository.create({
        usuarioId: usuario.id,
        nombre: `Auxiliar ${unico}`,
        precioVenta: 20,
      }),
    ]);
    productoId = p1.id;
    productoAuxId = p2.id;

    const login = await request(http())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    token = (login.body as { access_token: string }).access_token;
  });

  afterAll(async () => {
    // No hay CASCADE desde usuarios hacia tickets ni productos.
    await ticketRepository.delete({ usuarioId: usuario.id });
    await productoRepository.delete({ usuarioId: usuario.id });
    await usuarioRepository.delete({ id: usuario.id });
    await app.close();
  });

  it('a) prueba vigente: escribe tickets y productos', async () => {
    await fijarSuscripcion(pruebaVigente());

    await postTicket().expect(201);

    const conCampoDescartado = await postTicket({
      ...ticketBody(),
      borrador_iniciado_en: new Date().toISOString(),
    }).expect(400);
    expect(JSON.stringify(conCampoDescartado.body)).toContain(
      'borrador_iniciado_en',
    );

    const creado = await auth(request(http()).post('/productos'))
      .send({ nombre: `Nuevo ${unico}`, precio_venta: 10 })
      .expect(201);
    const id = (creado.body as { id: string }).id;
    await auth(request(http()).patch(`/productos/${id}`))
      .send({ precio_venta: 12 })
      .expect(200);
    await auth(request(http()).delete(`/productos/${id}`)).expect(200);
  });

  it('b) prueba vencida hace 1 hora: bloquea escrituras y no las lecturas', async () => {
    await fijarSuscripcion(pruebaVencida());

    const r1 = await postTicket().expect(403);
    expect(r1.body).toEqual(BLOQUEO);

    const r2 = await auth(request(http()).post('/productos'))
      .send({ nombre: `Bloqueado ${unico}`, precio_venta: 10 })
      .expect(403);
    expect(r2.body).toEqual(BLOQUEO);

    const r3 = await auth(request(http()).patch(`/productos/${productoAuxId}`))
      .send({ precio_venta: 25 })
      .expect(403);
    expect(r3.body).toEqual(BLOQUEO);

    const r4 = await auth(
      request(http()).delete(`/productos/${productoAuxId}`),
    ).expect(403);
    expect(r4.body).toEqual(BLOQUEO);

    // El guard corre antes que ParseUUIDPipe y que el ValidationPipe.
    const r5 = await auth(request(http()).patch('/productos/no-es-uuid'))
      .send({ campo_inexistente: 1 })
      .expect(403);
    expect(r5.body).toEqual(BLOQUEO);
    await postTicket({ items: [] }).expect(403);

    const ahora = new Date();
    await auth(request(http()).get('/productos?search=a')).expect(200);
    await auth(request(http()).get('/productos/catalogo')).expect(200);
    await auth(request(http()).get('/reportes/dia')).expect(200);
    await auth(
      request(http()).get(
        `/reportes/mes?mes=${ahora.getMonth() + 1}&anio=${ahora.getFullYear()}`,
      ),
    ).expect(200);
    await auth(request(http()).get('/me')).expect(200);
    const susc = await auth(request(http()).get('/me/suscripcion')).expect(200);
    expect((susc.body as { estado: string }).estado).toBe('prueba_vencida');

    // El producto no se modificó ni se borró.
    const sigue = await productoRepository.findOneBy({ id: productoAuxId });
    expect(sigue?.precioVenta).toBe(20);
  });

  it('c) vencida y pago_en_proceso bloquean', async () => {
    await fijarSuscripcion({
      ...pruebaVigente(),
      estado: 'vencida',
      motivo: 'cobro_fallido',
    });
    expect((await postTicket().expect(403)).body).toEqual(BLOQUEO);

    await fijarSuscripcion({
      ...pruebaVigente(),
      estado: 'pago_en_proceso',
      motivo: null,
      tienda: 'google_play',
    });
    expect((await postTicket().expect(403)).body).toEqual(BLOQUEO);
  });

  it('c) cancelada con acceso_hasta futuro escribe; con acceso_hasta pasado no', async () => {
    await fijarSuscripcion({
      ...pruebaVencida(),
      estado: 'cancelada',
      motivo: 'cancelada',
      tienda: 'google_play',
      accesoHasta: dias(5),
    });
    await postTicket().expect(201);

    await fijarSuscripcion({ accesoHasta: horas(-1) });
    expect((await postTicket().expect(403)).body).toEqual(BLOQUEO);
  });

  it('c) activa con renovación automática escribe', async () => {
    await fijarSuscripcion({
      ...pruebaVencida(),
      estado: 'activa',
      motivo: null,
      tienda: 'google_play',
      accesoHasta: dias(30),
      proximoCobro: dias(30),
      renovacionAutomatica: true,
    });
    await postTicket().expect(201);
  });

  it('d) al volver a activa se desbloquea sin pasos extra', async () => {
    await fijarSuscripcion(pruebaVencida());
    await postTicket().expect(403);

    await fijarSuscripcion({
      estado: 'activa',
      tienda: 'google_play',
      accesoHasta: dias(30),
      proximoCobro: dias(30),
      renovacionAutomatica: true,
    });
    await postTicket().expect(201);
  });
});
