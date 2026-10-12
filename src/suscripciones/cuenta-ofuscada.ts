import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CONFIG_SUSCRIPCION } from './config-suscripcion';
import type { ConfigSuscripcion } from './config-suscripcion';

/**
 * `cuenta_ofuscada` = HMAC-SHA256(usuario.id, SUSCRIPCION_HMAC_SECRETO) en
 * hexadecimal: 64 caracteres, el máximo que admite Google en
 * `obfuscatedAccountId`. Es determinista y no se guarda. El secreto NO se rota
 * nunca: cambiarlo rompería la correspondencia con las compras ya hechas.
 */
export function calcularCuentaOfuscada(
  usuarioId: string,
  secreto: string,
): string {
  return createHmac('sha256', secreto).update(usuarioId).digest('hex');
}

@Injectable()
export class CuentaOfuscadaService {
  constructor(
    @Inject(CONFIG_SUSCRIPCION) private readonly config: ConfigSuscripcion,
  ) {}

  calcular(usuarioId: string): string {
    return calcularCuentaOfuscada(usuarioId, this.config.hmacSecreto);
  }
}
