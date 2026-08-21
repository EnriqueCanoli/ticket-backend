import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `usuarios.phone` nunca tuvo restricción de unicidad, ni en la app ni en la
 * base de datos: dos cuentas podían compartir el mismo número de teléfono.
 *
 * El chequeo que se agregue en `AuthService.register()` (si se agrega) por sí
 * solo tiene una ventana de condición de carrera — dos registros concurrentes
 * con el mismo teléfono nuevo podrían pasar ambos un `findOne` antes de que
 * cualquiera de los dos haga `save()` — así que este `UNIQUE` a nivel de base
 * de datos es la única garantía real, igual que ya se hizo para `email` con
 * el índice `UQ_usuarios_email_lower` (migración NormalizeUsuariosEmail).
 *
 * Riesgo conocido: si ya existen filas de prueba con el mismo teléfono
 * repetido, este `ALTER TABLE ... ADD CONSTRAINT` va a fallar. Proyecto en
 * desarrollo, sin datos de producción que preservar: si eso pasa, la
 * recomendación es resetear la base de datos de prueba, no escribir lógica
 * de merge de cuentas.
 */
export class AddUniquePhoneToUsuarios1786880000000 implements MigrationInterface {
  name = 'AddUniquePhoneToUsuarios1786880000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "usuarios" ADD CONSTRAINT "UQ_usuarios_phone" UNIQUE ("phone");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "usuarios" DROP CONSTRAINT "UQ_usuarios_phone";
    `);
  }
}
