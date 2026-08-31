import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ReportesService } from './reportes.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { Usuario } from '../usuarios/entities/usuario.entity';
import type {
  ReporteDiaItem,
  ReporteMesItem,
} from './interfaces/reporte-response.interface';

const MES_MIN = 1;
const MES_MAX = 12;

/**
 * Valida que `tz` sea una zona horaria IANA reconocida (ej. "America/Cancun"),
 * sin dependencias nuevas: `Intl.DateTimeFormat` lanza `RangeError` si el
 * identificador no es válido para el motor ICU embebido en Node/V8. `tz`
 * `undefined` (el cliente no lo mandó) se considera válido — el fallback lo
 * resuelve el service.
 */
function esTimeZoneValida(tz: string): boolean {
  try {
    const formatter = new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return Boolean(formatter);
  } catch {
    return false;
  }
}

/**
 * Rutas sin prefijo global (features/vendido/ENDPOINTS.md sección 1, mismo
 * patrón que `auth/`, `productos/`, `tickets/`): `GET /reportes/dia`,
 * `GET /reportes/mes`.
 *
 * Alcance estrictamente por cuenta: `usuarioId` se resuelve del JWT vía
 * `@CurrentUser()` (mismo mecanismo que `ProductosController`/
 * `TicketsController`), nunca de query/body.
 */
@Controller()
export class ReportesController {
  constructor(private readonly reportesService: ReportesService) {}

  /**
   * `tz` (opcional): zona horaria IANA del dispositivo del cliente (ej.
   * "America/Cancun"), usada para decidir qué es "hoy" y para formatear
   * `hora` — ver el JSDoc de `ReportesService.getDia`. Si no viene, el
   * service aplica su propio fallback. Si viene pero no es una zona IANA
   * reconocida por el motor ICU, se responde `400` antes de tocar la base.
   */
  @Get('reportes/dia')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  getDia(
    @Query('tz') tz: string | undefined,
    @CurrentUser() usuario: Usuario,
  ): Promise<ReporteDiaItem[]> {
    if (tz !== undefined && !esTimeZoneValida(tz)) {
      throw new BadRequestException('tz must be a valid IANA time zone');
    }

    return this.reportesService.getDia(usuario.id, tz);
  }

  /**
   * `mes`/`anio` se validan con `ParseIntPipe` por parámetro, no con un DTO de
   * `class-validator` (§5.6): el `ValidationPipe` global corre sin
   * `transform: true` (ver `main.ts`), así que un DTO no coaccionaría el
   * query param string a number antes de validar. El rango 1-12 de `mes` y
   * que `anio` sea positivo se valida a mano acá, antes de llamar al
   * service, porque `ParseIntPipe` no valida rangos.
   *
   * `anio` es opcional: cuando no viene en el query, no se calcula ningún
   * default en JS (un `new Date().getFullYear()` quedaría fijo en el momento
   * en que arrancó el proceso de Node, no en cada request). En su lugar se
   * pasa `undefined` al service, que arma el rango del mes contra el año
   * actual en la zona horaria resuelta (ver `tz` abajo), igual que `getDia`
   * ya hace con su rango de día (§5.9).
   *
   * `tz` (opcional): misma zona horaria IANA del dispositivo descrita en
   * `getDia`, con la misma validación y el mismo fallback si se omite.
   */
  @Get('reportes/mes')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  getMes(
    @Query('mes', ParseIntPipe) mes: number,
    @Query('anio', new ParseIntPipe({ optional: true }))
    anio: number | undefined,
    @Query('tz') tz: string | undefined,
    @CurrentUser() usuario: Usuario,
  ): Promise<ReporteMesItem[]> {
    if (mes < MES_MIN || mes > MES_MAX) {
      throw new BadRequestException(
        `mes must be between ${MES_MIN} and ${MES_MAX}`,
      );
    }
    if (anio !== undefined && anio < 1) {
      throw new BadRequestException('anio must be a positive integer');
    }
    if (tz !== undefined && !esTimeZoneValida(tz)) {
      throw new BadRequestException('tz must be a valid IANA time zone');
    }

    return this.reportesService.getMes(usuario.id, mes, anio, tz);
  }
}
