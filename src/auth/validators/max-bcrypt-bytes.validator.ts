import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * bcrypt (y bcryptjs, usado en este proyecto) trunca el input a 72 bytes en
 * UTF-8 de forma silenciosa: cualquier byte después del 72 se ignora al
 * hashear. Sin este límite, dos contraseñas distintas que compartan los
 * primeros 72 bytes abrirían la misma cuenta, y una contraseña larga con
 * acentos/emojis (que pesan 2-4 bytes cada uno en UTF-8) quedaría recortada
 * sin que el usuario lo sepa. Este validador rechaza explícitamente cualquier
 * valor que exceda el límite real de bcrypt, en vez de dejar que lo trunque
 * en silencio. De paso, cierra el vector de DoS de mandar un password
 * enorme: se rechaza en el ValidationPipe, antes de llegar a bcrypt.hash /
 * bcrypt.compare.
 */
const BCRYPT_MAX_BYTES = 72;

export function MaxBcryptBytes(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'maxBcryptBytes',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string') {
            return false;
          }
          return Buffer.byteLength(value, 'utf8') <= BCRYPT_MAX_BYTES;
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must not exceed ${BCRYPT_MAX_BYTES} bytes (UTF-8) — bcrypt truncates longer inputs silently`;
        },
      },
    });
  };
}
