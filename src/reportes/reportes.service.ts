import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TicketItem } from '../tickets/entities/ticket-item.entity';
import {
  ReporteDiaItem,
  ReporteMesItem,
} from './interfaces/reporte-response.interface';

/**
 * Shape crudo devuelto por `getRawMany()` para `GET /reportes/dia`. Todas las
 * columnas numéricas llegan como `string` (features/vendido/ENDPOINTS.md
 * §5.3) — se convierten explícitamente en `toReporteDiaItem`.
 */
interface RawReporteDiaRow {
  id: string;
  producto_id: string;
  nombre_producto: string;
  cantidad: string;
  venta: string;
  costo: string;
  hora: string;
  costo_validado: boolean;
}

/** Shape crudo devuelto por `getRawMany()` para `GET /reportes/mes` (mismo motivo). */
interface RawReporteMesRow {
  producto_id: string;
  nombre_producto: string;
  cantidad: string;
  venta: string;
  ganancia: string;
  costo_validado: boolean;
}

/**
 * Zona horaria IANA usada cuando el cliente no manda `tz` (clientes viejos ya
 * instalados que todavía no envían el query param). No hardcodear este
 * string en ningún otro lugar de este archivo — todas las queries deben
 * referenciar esta constante.
 */
const TIMEZONE_FALLBACK = 'America/Mexico_City';

@Injectable()
export class ReportesService {
  constructor(
    @InjectRepository(TicketItem)
    private readonly ticketItemRepository: Repository<TicketItem>,
  ) {}

  /**
   * GET /reportes/dia (features/vendido/ENDPOINTS.md sección 2): líneas de
   * venta individuales del día calendario actual del usuario autenticado.
   *
   * `tz` es la zona horaria IANA del dispositivo del cliente (validada en el
   * controller; usa `TIMEZONE_FALLBACK` si el cliente no la mandó). El rango
   * del día y `hora` (§5.2, §5.9) se calculan enteramente en SQL a partir de
   * esa zona — nunca de la zona de la sesión de Postgres ni de `Date` de
   * JavaScript — así "hoy" y la hora mostrada quedan alineados con el
   * dispositivo del usuario sin importar en qué zona corra el servidor de
   * base de datos (relevante en Neon, donde la sesión es UTC).
   *
   * El rango se arma con la medianoche local del usuario en ambos extremos:
   * `(CURRENT_TIMESTAMP AT TIME ZONE :tz)::date` primero convierte el
   * instante actual a la hora de pared en `tz` (esa forma de `AT TIME ZONE`,
   * aplicada a un `timestamptz`, devuelve un `timestamp` sin zona) y trunca
   * al día; el `AT TIME ZONE :tz` exterior reinterpreta esa fecha/hora de
   * pared como perteneciente a `tz` y la vuelve a convertir a `timestamptz`
   * (la otra dirección de `AT TIME ZONE`, aplicada a un `timestamp`) para
   * poder compararla contra `t.createdAt`.
   *
   * IMPORTANTE: entre el `::date` y el `AT TIME ZONE` exterior se agrega un
   * `::timestamp` explícito. Sin él, `date AT TIME ZONE zone` es ambiguo —
   * `date` tiene cast implícito tanto a `timestamp` como a `timestamptz`, y
   * Postgres desempata prefiriendo `timestamptz` (tipo preferido de la
   * categoría datetime). Esa resolución interpreta la fecha truncada como
   * medianoche en la zona de la SESIÓN (no en `tz`) antes de convertirla —
   * reintroduciendo en silencio la misma dependencia de la zona del servidor
   * que este cambio busca eliminar. Verificado localmente: sin el
   * `::timestamp`, el bound resultante cambiaba varias horas según
   * `SET TIME ZONE 'UTC'` vs. `'America/Mexico_City'` en la misma sesión;
   * con el `::timestamp`, el bound es el mismo instante absoluto sin
   * importar la zona de la sesión. Los bounds quedan como constantes por
   * query (no se envuelve `t.createdAt` en ninguna función), así el filtro
   * sigue siendo sargable y el índice sobre `tickets` sigue sirviendo.
   */
  async getDia(usuarioId: string, tz?: string): Promise<ReporteDiaItem[]> {
    const zonaHoraria = tz ?? TIMEZONE_FALLBACK;

    const rows = await this.ticketItemRepository
      .createQueryBuilder('ti')
      .innerJoin('ti.ticket', 't')
      .innerJoin('ti.producto', 'p')
      .select('ti.id', 'id')
      .addSelect('ti.productoId', 'producto_id')
      .addSelect('p.nombre', 'nombre_producto')
      .addSelect('ti.cantidad', 'cantidad')
      .addSelect('ti.subtotal', 'venta')
      .addSelect('ti.cantidad * ti.costoUnitario', 'costo')
      .addSelect(
        "TO_CHAR(t.createdAt AT TIME ZONE :zonaHoraria, 'HH24:MI')",
        'hora',
      )
      .addSelect('p.costoValidado', 'costo_validado')
      .where('t.usuarioId = :usuarioId', { usuarioId })
      .andWhere(
        't.createdAt >= (CURRENT_TIMESTAMP AT TIME ZONE :zonaHoraria)::date::timestamp AT TIME ZONE :zonaHoraria',
      )
      .andWhere(
        "t.createdAt < ((CURRENT_TIMESTAMP AT TIME ZONE :zonaHoraria)::date::timestamp + interval '1 day') AT TIME ZONE :zonaHoraria",
      )
      .setParameter('zonaHoraria', zonaHoraria)
      .orderBy('t.createdAt', 'ASC')
      .getRawMany<RawReporteDiaRow>();

    return rows.map((row) => this.toReporteDiaItem(row));
  }

  /**
   * GET /reportes/mes (features/vendido/ENDPOINTS.md sección 3): totales del
   * mes/año pedidos, agregados por producto, del usuario autenticado.
   *
   * `mes`/`anio` ya llegaron validados desde el controller (rango 1-12 de
   * `mes`, entero positivo de `anio` cuando viene — §5.6). `anio` es
   * `undefined` cuando el cliente no lo mandó: en ese caso NO se calcula
   * ningún default en JS (evitaría quedar fijo al año en que arrancó el
   * proceso de Node si el servidor sigue corriendo al cruzar un Año Nuevo).
   * En su lugar se pasa `null` como parámetro SQL y `COALESCE` resuelve el
   * año contra `EXTRACT(YEAR FROM (CURRENT_TIMESTAMP AT TIME ZONE :zonaHoraria))`
   * — el año actual en la zona horaria del cliente (`tz`, validada en el
   * controller; usa `TIMEZONE_FALLBACK` si no vino), evaluado en cada
   * request. El rango del mes se arma con `make_date(...)` sobre ese año
   * resuelto, reinterpretado en esa misma zona con `AT TIME ZONE :zonaHoraria`
   * (mismo criterio que `getDia` — nunca la zona de la sesión de Postgres).
   * Igual que en `getDia`, `make_date(...)` (tipo `date`) se castea
   * explícitamente a `::timestamp` antes del `AT TIME ZONE` exterior — sin
   * ese cast, la ambigüedad de casts implícitos de `date` hace que Postgres
   * prefiera `timestamptz` y la fecha se reinterprete con la zona de la
   * sesión en vez de `:zonaHoraria` (ver el detalle completo en el JSDoc de
   * `getDia`).
   */
  async getMes(
    usuarioId: string,
    mes: number,
    anio: number | undefined,
    tz?: string,
  ): Promise<ReporteMesItem[]> {
    const zonaHoraria = tz ?? TIMEZONE_FALLBACK;
    const rangoParams = { anio: anio ?? null, mes, zonaHoraria };
    const anioExpr =
      'COALESCE(:anio::int, EXTRACT(YEAR FROM (CURRENT_TIMESTAMP AT TIME ZONE :zonaHoraria))::int)';

    const rows = await this.ticketItemRepository
      .createQueryBuilder('ti')
      .innerJoin('ti.ticket', 't')
      .innerJoin('ti.producto', 'p')
      .select('p.id', 'producto_id')
      .addSelect('p.nombre', 'nombre_producto')
      .addSelect('SUM(ti.cantidad)', 'cantidad')
      .addSelect('SUM(ti.subtotal)', 'venta')
      .addSelect(
        'SUM(ti.subtotal - ti.cantidad * ti.costoUnitario)',
        'ganancia',
      )
      .addSelect('p.costoValidado', 'costo_validado')
      .where('t.usuarioId = :usuarioId', { usuarioId })
      .andWhere(
        `t.createdAt >= make_date(${anioExpr}, :mes, 1)::timestamp AT TIME ZONE :zonaHoraria`,
        rangoParams,
      )
      .andWhere(
        `t.createdAt < (make_date(${anioExpr}, :mes, 1)::timestamp + interval '1 month') AT TIME ZONE :zonaHoraria`,
        rangoParams,
      )
      .groupBy('p.id')
      .addGroupBy('p.nombre')
      .addGroupBy('p.costoValidado')
      .orderBy('p.nombre', 'ASC')
      .getRawMany<RawReporteMesRow>();

    return rows.map((row) => this.toReporteMesItem(row));
  }

  /** §5.3: getRawMany() no pasa por numericTransformer — se convierte a mano. */
  private toReporteDiaItem(row: RawReporteDiaRow): ReporteDiaItem {
    return {
      id: row.id,
      producto_id: row.producto_id,
      nombre_producto: row.nombre_producto,
      cantidad: Number(row.cantidad),
      venta: Number(row.venta),
      costo: Number(row.costo),
      hora: row.hora,
      // `boolean` de Postgres llega ya nativo vía el driver `pg` (a diferencia de `numeric`),
      // así que no pasa por Number(...) ni ninguna conversión.
      costo_validado: row.costo_validado,
    };
  }

  private toReporteMesItem(row: RawReporteMesRow): ReporteMesItem {
    return {
      producto_id: row.producto_id,
      nombre_producto: row.nombre_producto,
      cantidad: Number(row.cantidad),
      venta: Number(row.venta),
      ganancia: Number(row.ganancia),
      costo_validado: row.costo_validado,
    };
  }
}
