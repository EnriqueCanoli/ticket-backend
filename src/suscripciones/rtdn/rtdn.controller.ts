import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { VERIFICADOR_PUSH } from './pubsub-auth';
import type { VerificadorPush } from './pubsub-auth';
import { LONGITUD_MAXIMA_MESSAGE_ID } from './rtdn.types';
import type { SobrePubSub } from './rtdn.types';
import { RtdnService } from './rtdn.service';

export const MENSAJE_SIN_MESSAGE_ID =
  'MESSAGE_ID_REQUERIDO: el aviso no trae message.messageId';

/**
 * Push de Pub/Sub con las notificaciones RTDN de Google Play (etapa 5).
 * Sin `JwtAuthGuard` (lo llama Pub/Sub, no la app) y sin throttle. El body se
 * tipa con una interface para que el `ValidationPipe` global no lo valide.
 * Códigos: 200 procesado/ignorado/duplicado/desconocido/inválido/prueba; 400
 * sin `messageId`; 401 firma inválida; 503 Google o sus certificados no
 * disponibles (Pub/Sub reintenta); 500 error inesperado.
 */
@Controller()
export class RtdnController {
  constructor(
    @Inject(VERIFICADOR_PUSH) private readonly verificador: VerificadorPush,
    private readonly rtdnService: RtdnService,
  ) {}

  @Post('tienda/google/rtdn')
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  async recibir(
    @Body() cuerpo: SobrePubSub,
    @Headers('authorization') authorization?: string,
  ): Promise<void> {
    // 1. Firma de Pub/Sub; si falla, no se toca la BD.
    await this.verificador.verificar(authorization);

    // 2. messageId (Pub/Sub lo manda en camelCase; en snake_case en otros formatos).
    const mensaje = cuerpo?.message;
    const messageId = mensaje?.messageId ?? mensaje?.message_id;
    if (
      typeof messageId !== 'string' ||
      messageId === '' ||
      messageId.length > LONGITUD_MAXIMA_MESSAGE_ID
    ) {
      throw new BadRequestException(MENSAJE_SIN_MESSAGE_ID);
    }

    // 3. Procesamiento idempotente; la respuesta es vacía.
    await this.rtdnService.procesar(messageId, mensaje?.data);
  }
}
