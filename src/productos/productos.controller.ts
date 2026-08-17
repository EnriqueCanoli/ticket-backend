import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { ProductosService } from './productos.service';
import { SearchProductosDto } from './dto/search-productos.dto';
import { CreateProductoDto } from './dto/create-producto.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { Usuario } from '../usuarios/entities/usuario.entity';
import type { ProductoResponse, ProductoSearchResult } from './interfaces/producto-response.interface';

/**
 * Rutas sin prefijo global (ENDPOINTS.md sección 1, mismo patrón que
 * `auth/`): `GET /productos`, `POST /productos`.
 *
 * Catálogo privado por usuario: `usuarioId` se resuelve del JWT vía
 * `@CurrentUser()` (mismo mecanismo que `TicketsController`), nunca del
 * body/query.
 */
@Controller()
export class ProductosController {
  constructor(private readonly productosService: ProductosService) {}

  @Get('productos')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  search(
    @Query() dto: SearchProductosDto,
    @CurrentUser() usuario: Usuario,
  ): Promise<ProductoSearchResult[]> {
    return this.productosService.search(dto.search, usuario.id);
  }

  @Post('productos')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard)
  create(@Body() dto: CreateProductoDto, @CurrentUser() usuario: Usuario): Promise<ProductoResponse> {
    return this.productosService.create(dto, usuario.id);
  }
}
