import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El email nunca se normalizó a nivel de base de datos: `UQ_usuarios_email`
 * (InitialSchema) es un UNIQUE case-sensitive, así que "Juan@gmail.com" y
 * "juan@gmail.com" podían coexistir como cuentas distintas. Con la app ya
 * normalizando a minúsculas antes de guardar/consultar (AuthService.register
 * y .login), se reemplaza esa restricción por un índice único funcional sobre
 * LOWER(email): además de reflejar la garantía real, protege contra cualquier
 * futuro camino de código que olvide normalizar (inserciones manuales,
 * scripts, features nuevas).
 *
 * Riesgo conocido: si ya existen filas de prueba con el mismo email en
 * distinto case (el escenario exacto que motivó este fix), CREATE UNIQUE
 * INDEX va a fallar. Proyecto en desarrollo: si eso pasa, la recomendación es
 * resetear la base de datos de prueba, no escribir lógica de merge de cuentas.
 */
export class NormalizeUsuariosEmail1786870000000 implements MigrationInterface {
  name = 'NormalizeUsuariosEmail1786870000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "usuarios" DROP CONSTRAINT "UQ_usuarios_email";
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_usuarios_email_lower" ON "usuarios" (LOWER("email"));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_usuarios_email_lower";
    `);
    await queryRunner.query(`
      ALTER TABLE "usuarios" ADD CONSTRAINT "UQ_usuarios_email" UNIQUE ("email");
    `);
  }
}
