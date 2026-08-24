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
   * El rango del día (§5.9) se calcula enteramente en SQL con `CURRENT_DATE`
   * (zona horaria de la sesión de Postgres), no con `Date` de JavaScript, para
   * no desalinear "hoy" respecto a la zona del servidor. `hora` (§5.2) se
   * formatea también en SQL (`TO_CHAR(t.createdAt, 'HH24:MI')`) con la misma
   * referencia horaria usada para decidir el rango, así el cliente no aplica
   * ninguna conversión de zona propia.
   */
  async getDia(usuarioId: string): Promise<ReporteDiaItem[]> {
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
      .addSelect("TO_CHAR(t.createdAt, 'HH24:MI')", 'hora')
      .addSelect('p.costoValidado', 'costo_validado')
      .where('t.usuarioId = :usuarioId', { usuarioId })
      .andWhere('t.createdAt >= CURRENT_DATE')
      .andWhere("t.createdAt < CURRENT_DATE + interval '1 day'")
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
   * año contra `EXTRACT(YEAR FROM CURRENT_DATE)` — el año actual de Postgres,
   * evaluado en cada request, consistente con el mismo criterio de "zona del
   * servidor" que `getDia` ya usa con `CURRENT_DATE` (§5.9). El rango del mes
   * se arma con `make_date(...)` sobre ese año resuelto.
   */
  async getMes(
    usuarioId: string,
    mes: number,
    anio: number | undefined,
  ): Promise<ReporteMesItem[]> {
    const rangoParams = { anio: anio ?? null, mes };
    const anioExpr =
      'COALESCE(:anio::int, EXTRACT(YEAR FROM CURRENT_DATE)::int)';

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
      .andWhere(`t.createdAt >= make_date(${anioExpr}, :mes, 1)`, rangoParams)
      .andWhere(
        `t.createdAt < make_date(${anioExpr}, :mes, 1) + interval '1 month'`,
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
