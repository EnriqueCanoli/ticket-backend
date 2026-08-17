import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ProductosService } from './productos.service';
import { SearchProductosDto } from './dto/search-productos.dto';
import { CreateProductoDto } from './dto/create-producto.dto';
import { UpdateProductoDto } from './dto/update-producto.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { Usuario } from '../usuarios/entities/usuario.entity';
import type {
  ProductoCatalogoItem,
  ProductoDeleteResponse,
  ProductoResponse,
  ProductoSearchResult,
} from './interfaces/producto-response.interface';

/**
 * Rutas sin prefijo global (ENDPOINTS.md sección 1, features/productos/ENDPOINTS.md
 * sección 1, mismo patrón que `auth/`): `GET /productos`, `GET /productos/catalogo`,
 * `POST /productos`, `PATCH /productos/:id`, `DELETE /productos/:id`.
 *
 * Catálogo privado por usuario: `usuarioId` se resuelve del JWT vía
 * `@CurrentUser()` (mismo mecanismo que `TicketsController`), nunca del
 * body/query/params.
 *
 * Orden de métodos deliberado: `GET /productos/catalogo` (ruta estática) se
 * declara antes que cualquier ruta con `:id`, para evitar que Nest intente
 * matchear "catalogo" como un `:id` paramétrico.
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

  @Get('productos/catalogo')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  findCatalogo(@CurrentUser() usuario: Usuario): Promise<ProductoCatalogoItem[]> {
    return this.productosService.findCatalogo(usuario.id);
  }

  @Post('productos')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard)
  create(@Body() dto: CreateProductoDto, @CurrentUser() usuario: Usuario): Promise<ProductoResponse> {
    return this.productosService.create(dto, usuario.id);
  }

  @Patch('productos/:id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductoDto,
    @CurrentUser() usuario: Usuario,
  ): Promise<ProductoResponse> {
    return this.productosService.update(id, dto, usuario.id);
  }

  @Delete('productos/:id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() usuario: Usuario,
  ): Promise<ProductoDeleteResponse> {
    return this.productosService.remove(id, usuario.id);
  }
}
