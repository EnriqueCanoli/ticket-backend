import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { Usuario } from '../usuarios/entities/usuario.entity';
import type { TicketResponse } from './interfaces/ticket-response.interface';

/** Ruta sin prefijo global (ENDPOINTS.md sección 1, mismo patrón que `auth/`): `POST /tickets`. */
@Controller()
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

  @Post('tickets')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard)
  create(
    @Body() dto: CreateTicketDto,
    @CurrentUser() usuario: Usuario,
  ): Promise<TicketResponse> {
    return this.ticketsService.create(dto, usuario.id);
  }
}
