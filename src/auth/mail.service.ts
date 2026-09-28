import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly configService: ConfigService) {
    // Fail-fast: si el backend corre en producción sin clave de Brevo, el
    // arranque debe fallar acá, de forma ruidosa. Sin esto, la ausencia de
    // la clave solo se descubre cuando alguien pide un código de reset, y
    // como forgotPassword() dispara el envío en modo fire-and-forget, el
    // error queda atrapado en un .catch() que solo loguea — el cliente
    // recibe 200 igual y nunca le llega el código, sin ninguna señal salvo
    // un ERROR en el log (bug confirmado por QA, ver informe 2026-09-22).
    // Mismo espíritu que JWT_SECRET en auth.module.ts, pero sin
    // configService.getOrThrow(): esa función solo lanza cuando el valor es
    // `undefined` (ver @nestjs/config/dist/config.service.js), así que NO
    // detecta BREVO_API_KEY='' (variable presente pero vacía) — justamente
    // uno de los dos escenarios que QA probó explícitamente ("vacía o
    // ausente"). El chequeo de truthiness de abajo cubre ambos casos.
    if (this.configService.get('NODE_ENV') === 'production') {
      const apiKey = this.configService.get<string>('BREVO_API_KEY');
      if (!apiKey) {
        throw new Error(
          'BREVO_API_KEY no configurada: requerida en producción para el envío de correos (ver src/auth/mail.service.ts)',
        );
      }
    }
  }

  async sendPasswordResetCode(email: string, code: string): Promise<void> {
    const apiKey = this.configService.get<string>('BREVO_API_KEY');
    if (!apiKey) {
      // En producción, este punto ya es inalcanzable en la práctica: el
      // constructor de arriba hace fallar el arranque si falta la clave.
      // Se deja este chequeo como defensa adicional (ej. si la variable se
      // borra en runtime después de arrancar), sin cambiar el comportamiento
      // de desarrollo/test, que sigue logueando el código en vez de enviarlo.
      if (this.configService.get('NODE_ENV') === 'production') {
        throw new Error('BREVO_API_KEY no configurada');
      }
      this.logger.warn(`[DEV] Código de reset para ${email}: ${code}`);
      return;
    }

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: {
          email: this.configService.get<string>('MAIL_FROM_EMAIL'),
          name: this.configService.get<string>('MAIL_FROM_NAME') ?? 'Ticket',
        },
        to: [{ email }],
        subject: 'Código para restablecer tu contraseña',
        htmlContent: `<p>Tu código para restablecer tu contraseña es:</p><h2>${code}</h2><p>Vence en 15 minutos. Si no lo solicitaste, ignora este correo.</p>`,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Brevo respondió ${response.status}: ${await response.text()}`,
      );
    }
  }
}
