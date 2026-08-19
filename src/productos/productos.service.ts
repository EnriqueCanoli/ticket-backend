import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, ILike, Repository } from 'typeorm';
import { Producto } from './entities/producto.entity';
import { TicketItem } from '../tickets/entities/ticket-item.entity';
import { CreateProductoDto } from './dto/create-producto.dto';
import { UpdateProductoDto } from './dto/update-producto.dto';
import {
  ProductoCatalogoItem,
  ProductoDeleteResponse,
  ProductoResponse,
  ProductoSearchResult,
} from './interfaces/producto-response.interface';

/** ENDPOINTS.md §5.2: tope server-side para no exponer catálogos completos en búsquedas genéricas. */
const SEARCH_RESULT_LIMIT = 20;

/**
 * Defaults del alta rápida desde el buscador de ticket (ENDPOINTS.md sección
 * 3, README_DB_PROPUESTA.md §3.2): el cliente no captura costo, el backend
 * lo fija.
 */
const DEFAULT_COSTO = 1;
const DEFAULT_COSTO_VALIDADO = false;

@Injectable()
export class ProductosService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(Producto)
    private readonly productoRepository: Repository<Producto>,
  ) {}

  /**
   * `ILIKE '%search%'` sobre `nombre`, case-insensitive, orden `nombre ASC`
   * (ENDPOINTS.md sección 2). El `trim()` del término se hace acá (no en el
   * DTO) porque el `ValidationPipe` global no usa `transform: true`.
   *
   * Catálogo privado por usuario: solo busca entre los productos del
   * `usuarioId` autenticado (resuelto del JWT en el controller).
   */
  async search(
    search: string,
    usuarioId: string,
  ): Promise<ProductoSearchResult[]> {
    const term = search.trim();

    const productos = await this.productoRepository.find({
      where: { nombre: ILike(`%${term}%`), usuarioId, activo: true },
      order: { nombre: 'ASC' },
      take: SEARCH_RESULT_LIMIT,
    });

    return productos.map((producto) => this.toSearchResult(producto));
  }

  /**
   * `costo`/`costo_validado` fijados en el servidor, nunca recibidos del DTO
   * directamente: si `dto.costo` viene definido, se usa y se marca el
   * producto como validado; si no, se mantiene el comportamiento original
   * del alta rápida (features/productos/ENDPOINTS.md sección 3).
   * `usuarioId` viene del JWT (resuelto en el controller), nunca del body:
   * el producto creado queda en el catálogo privado de ese usuario.
   */
  async create(
    dto: CreateProductoDto,
    usuarioId: string,
  ): Promise<ProductoResponse> {
    const costoValidado = dto.costo !== undefined;

    const producto = this.productoRepository.create({
      nombre: dto.nombre,
      precioVenta: dto.precio_venta,
      costo: costoValidado ? dto.costo : DEFAULT_COSTO,
      costoValidado: costoValidado ? true : DEFAULT_COSTO_VALIDADO,
      usuarioId,
    });
    await this.productoRepository.save(producto);

    return this.toResponse(producto);
  }

  /**
   * GET /productos/catalogo (features/productos/ENDPOINTS.md sección 2):
   * catálogo completo activo del usuario, sin `search` ni `take` (sin límite
   * server-side, ver §8.2).
   */
  async findCatalogo(usuarioId: string): Promise<ProductoCatalogoItem[]> {
    const productos = await this.productoRepository.find({
      where: { usuarioId, activo: true },
      order: { nombre: 'ASC' },
    });

    return productos.map((producto) => this.toCatalogoItem(producto));
  }

  /**
   * PATCH /productos/:id (features/productos/ENDPOINTS.md sección 4). Busca
   * por `id` + `usuarioId` + `activo = true`: cualquier otra causa de "no
   * match" (no existe, es de otro usuario, ya está inactivo) responde el
   * mismo `404` genérico, a propósito, para no filtrar información entre
   * cuentas (ver §8.1). `costo_validado` se fuerza siempre a `true`.
   */
  async update(
    id: string,
    dto: UpdateProductoDto,
    usuarioId: string,
  ): Promise<ProductoResponse> {
    if (
      dto.nombre === undefined &&
      dto.costo === undefined &&
      dto.precio_venta === undefined
    ) {
      throw new BadRequestException(
        'At least one of nombre, costo, precio_venta must be provided',
      );
    }

    const producto = await this.productoRepository.findOne({
      where: { id, usuarioId, activo: true },
    });
    if (!producto) {
      throw new NotFoundException('Producto not found');
    }

    // Estado previo, leído de BD antes de mutar la entidad: dispara (y acota) la
    // corrección retroactiva del histórico. `costoAnterior` se lee de la fila real
    // y no se asume igual a DEFAULT_COSTO, para no depender de esa constante.
    const costoValidadoAnterior = producto.costoValidado;
    const costoAnterior = producto.costo;

    if (dto.nombre !== undefined) {
      producto.nombre = dto.nombre;
    }
    if (dto.costo !== undefined) {
      producto.costo = dto.costo;
    }
    if (dto.precio_venta !== undefined) {
      producto.precioVenta = dto.precio_venta;
    }
    producto.costoValidado = true;

    // Escenario "primera confirmación de costo" (costo_validado: false -> true): las
    // ventas ya registradas de este producto quedaron con `costo_unitario` congelado
    // en el placeholder (DEFAULT_COSTO), así que se corrigen retroactivamente para que
    // los reportes históricos muestren la ganancia real. El filtro por `costoAnterior`
    // es defensivo: solo se tocan las líneas que efectivamente traen ese valor viejo.
    // Si el producto ya estaba validado, un cambio de costo aplica SOLO hacia adelante
    // y el histórico queda intacto (snapshot al momento de vender).
    const debeCorregirHistorial =
      costoValidadoAnterior === false && producto.costo !== costoAnterior;

    if (!debeCorregirHistorial) {
      await this.productoRepository.save(producto);
      return this.toResponse(producto);
    }

    const costoConfirmado = producto.costo;
    await this.dataSource.transaction(async (manager) => {
      await manager.save(producto);
      // Solo `costo_unitario`: `precio_venta_unitario`, `subtotal` y `tickets.total`
      // siempre fueron correctos (el alta rápida sí captura precio_venta).
      await manager.update(
        TicketItem,
        { productoId: producto.id, costoUnitario: costoAnterior },
        { costoUnitario: costoConfirmado },
      );
    });

    return this.toResponse(producto);
  }

  /**
   * DELETE /productos/:id (features/productos/ENDPOINTS.md sección 5):
   * soft-delete (`activo = false`), nunca `DELETE FROM`, por el
   * `ON DELETE RESTRICT` de `ticket_items.producto_id`. Mismo criterio de
   * búsqueda que `update` — doble-delete sobre uno ya inactivo es `404`
   * (§8.7).
   */
  async remove(id: string, usuarioId: string): Promise<ProductoDeleteResponse> {
    const producto = await this.productoRepository.findOne({
      where: { id, usuarioId, activo: true },
    });
    if (!producto) {
      throw new NotFoundException('Producto not found');
    }

    producto.activo = false;
    await this.productoRepository.save(producto);

    return { id: producto.id, activo: producto.activo };
  }

  private toSearchResult(producto: Producto): ProductoSearchResult {
    return {
      id: producto.id,
      nombre: producto.nombre,
      precio_venta: producto.precioVenta,
    };
  }

  private toResponse(producto: Producto): ProductoResponse {
    return {
      id: producto.id,
      nombre: producto.nombre,
      precio_venta: producto.precioVenta,
      costo: producto.costo,
      costo_validado: producto.costoValidado,
      created_at: producto.createdAt,
      updated_at: producto.updatedAt,
    };
  }

  private toCatalogoItem(producto: Producto): ProductoCatalogoItem {
    return {
      id: producto.id,
      nombre: producto.nombre,
      costo: producto.costo,
      precio_venta: producto.precioVenta,
      costo_validado: producto.costoValidado,
    };
  }
}
