import { Global, Module } from '@nestjs/common';
import { GatewayStore, PgGatewayStore } from './gateway.store';
import { LlmGateway } from './gateway.service';
import { AdapterRegistry } from './registry';

@Global()
@Module({
  providers: [AdapterRegistry, LlmGateway, { provide: GatewayStore, useClass: PgGatewayStore }],
  exports: [LlmGateway, AdapterRegistry],
})
export class LlmModule {}
