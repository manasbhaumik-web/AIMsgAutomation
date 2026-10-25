import { Module } from '@nestjs/common';
import { ProfileModule } from '../profile/profile.module';
import { AiController } from './ai.controller';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ConsentService } from './consent.service';
import { DigestService } from './digest.service';
import { DraftService } from './draft.service';
import { AiPipelineService } from './pipeline.service';
import { RetrievalService } from './retrieval.service';
import { SummaryService } from './summary.service';

@Module({
  imports: [ProfileModule],
  controllers: [AiController, ChatController],
  providers: [ConsentService, AiPipelineService, SummaryService, DigestService, RetrievalService, ChatService, DraftService],
  exports: [AiPipelineService, DigestService, ConsentService, DraftService],
})
export class AiModule {}
