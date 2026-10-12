import { createHash } from 'node:crypto';
import { sumarUnMesNegocio } from '../fechas';
import type {
  EntradaVerificacion,
  ResultadoVerificacion,
  VerificadorTienda,
} from './verificador-tienda.interface';

// TEMPORAL: precio real en 4b
export const MONTO_SIMULADO = 99;
// TEMPORAL: precio real en 4b
export const MONEDA_SIMULADA = 'MXN';

/** Id de cuenta que el simulador asocia a `mock-tienda-en-uso-` (cuenta ajena). */
export const CUENTA_SIMULADA_AJENA = 'cuenta-simulada-ajena';

function orderIdSimulado(token: string): string {
  return `SIM-${createHash('sha256').update(token).digest('hex').slice(0, 24)}`;
}

/**
 * Verificador de la etapa 4a: decide por el prefijo del token (los que genera
 * `src/shared/api/comprasMock.ts` del frontend). Nunca llama a la tienda.
 *
 * | Prefijo                | Resultado                                   |
 * |------------------------|---------------------------------------------|
 * | `mock-compra-`         | activa, ahora → ahora + 1 mes, 99 MXN       |
 * | `mock-pendiente-`      | pendiente, sin fechas ni monto              |
 * | `mock-tienda-en-uso-`  | como `mock-compra-` pero de cuenta ajena    |
 * | cualquier otro         | rechazada                                   |
 */
export class VerificadorSimulado implements VerificadorTienda {
  constructor(private readonly reloj: () => Date = () => new Date()) {}

  verificar({
    tokenCompra,
  }: EntradaVerificacion): Promise<ResultadoVerificacion> {
    const orderId = orderIdSimulado(tokenCompra);

    if (tokenCompra.startsWith('mock-pendiente-')) {
      return Promise.resolve({
        estado: 'pendiente',
        orderId,
        periodoInicio: null,
        periodoFin: null,
        autoRenovacion: false,
        cuentaOfuscada: null,
        monto: null,
        moneda: null,
      });
    }

    const ajena = tokenCompra.startsWith('mock-tienda-en-uso-');
    if (ajena || tokenCompra.startsWith('mock-compra-')) {
      const periodoInicio = this.reloj();
      return Promise.resolve({
        estado: 'activa',
        orderId,
        periodoInicio,
        periodoFin: sumarUnMesNegocio(periodoInicio),
        autoRenovacion: true,
        cuentaOfuscada: ajena ? CUENTA_SIMULADA_AJENA : null,
        monto: MONTO_SIMULADO,
        moneda: MONEDA_SIMULADA,
      });
    }

    return Promise.resolve({
      estado: 'rechazada',
      orderId: null,
      periodoInicio: null,
      periodoFin: null,
      autoRenovacion: false,
      cuentaOfuscada: null,
      monto: null,
      moneda: null,
    });
  }

  reconocer(): Promise<void> {
    return Promise.resolve();
  }
}
