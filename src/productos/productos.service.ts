import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';
import { Producto } from './entities/producto.entity';
import { CreateProductoDto } from './dto/create-producto.dto';
import { ProductoResponse, ProductoSearchResult } from './interfaces/producto-response.interface';

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
  async search(search: string, usuarioId: string): Promise<ProductoSearchResult[]> {
    const term = search.trim();

    const productos = await this.productoRepository.find({
      where: { nombre: ILike(`%${term}%`), usuarioId },
      order: { nombre: 'ASC' },
      take: SEARCH_RESULT_LIMIT,
    });

    return productos.map((producto) => this.toSearchResult(producto));
  }

  /**
   * `costo`/`costo_validado` fijados en el servidor, nunca recibidos del DTO.
   * `usuarioId` viene del JWT (resuelto en el controller), nunca del body:
   * el producto creado queda en el catálogo privado de ese usuario.
   */
  async create(dto: CreateProductoDto, usuarioId: string): Promise<ProductoResponse> {
    const producto = this.productoRepository.create({
      nombre: dto.nombre,
      precioVenta: dto.precio_venta,
      costo: DEFAULT_COSTO,
      costoValidado: DEFAULT_COSTO_VALIDADO,
      usuarioId,
    });
    await this.productoRepository.save(producto);

    return this.toResponse(producto);
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
}
