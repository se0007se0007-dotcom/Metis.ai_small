/**
 * Data Contract Agent for Metis.AI Builder Harness
 *
 * 노드 타입별 입출력 스키마를 정의하고, 연결된 노드 간의 데이터 호환성을 검증합니다.
 * 각 노드 타입은 NodeContract를 통해 다음을 명시합니다:
 * - inputs: 노드가 받기를 기대하는 데이터 스키마
 * - outputs: 노드가 생성하는 데이터 스키마
 * - transformDescription: 내부에서 일어나는 데이터 변환 설명
 *
 * Pipeline validation은 각 연속된 노드 쌍의 호환성을 검사하고 점수를 계산합니다.
 */

export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'object'
  | 'date'
  | 'json'
  | 'binary';

export type DataFormat = 'json' | 'text' | 'html' | 'csv' | 'binary' | 'xml';

export interface DataSchema {
  fields: Array<{
    key: string;
    type: FieldType;
    required: boolean;
    description: string;
    arrayElementType?: FieldType;
  }>;
  format: DataFormat;
  example: Record<string, any>;
  description: string;
}

export interface NodeContract {
  nodeType: string;
  inputs: DataSchema;
  outputs: DataSchema;
  transformDescription: string;
  validPredecessors: string[];
  validSuccessors: string[];
}

export interface CompatibilityMismatch {
  field: string;
  expected: string;
  actual: string;
  severity: 'blocking' | 'warning' | 'adaptable';
}

export interface CompatibilityAdaptation {
  description: string;
  autoApplicable: boolean;
  transformFunction?: string;
}

export interface CompatibilityResult {
  compatible: boolean;
  score: number;
  mismatches: CompatibilityMismatch[];
  adaptations: CompatibilityAdaptation[];
  reasoning: string;
}

export interface PipelineValidationResult {
  overallScore: number;
  pairs: Array<{
    from: string;
    to: string;
    result: CompatibilityResult;
  }>;
  isExecutable: boolean;
  summary: string;
}

// 16개 노드 타입의 데이터 계약 정의
export const NODE_CONTRACTS: Record<string, NodeContract> = {
  // 1. Schedule - 스케줄 트리거
  schedule: {
    nodeType: 'schedule',
    inputs: {
      fields: [
        { key: 'cronExpression', type: 'string', required: false, description: '크론 표현식' },
        { key: 'timezone', type: 'string', required: false, description: '타임존' },
      ],
      format: 'json',
      example: { cronExpression: '0 9 * * *', timezone: 'Asia/Seoul' },
      description: '스케줄 트리거 설정',
    },
    outputs: {
      fields: [
        { key: 'triggerTime', type: 'date', required: true, description: '트리거 시간' },
        { key: 'scheduleType', type: 'string', required: true, description: '스케줄 타입' },
        { key: 'isTriggered', type: 'boolean', required: true, description: '발동 여부' },
      ],
      format: 'json',
      example: { triggerTime: '2026-04-09T09:00:00Z', scheduleType: 'cron', isTriggered: true },
      description: '스케줄 실행 결과',
    },
    transformDescription: '크론 표현식을 평가하여 트리거 시간과 상태를 결정합니다.',
    validPredecessors: [],
    validSuccessors: ['web-search', 'ai-processing', 'email-send', 'slack-message', 'api-call'],
  },

  // 2. Web Search - 웹 검색
  'web-search': {
    nodeType: 'web-search',
    inputs: {
      fields: [
        { key: 'keywords', type: 'string', required: true, description: '검색 키워드' },
        { key: 'maxResults', type: 'number', required: false, description: '최대 결과 개수' },
        { key: 'language', type: 'string', required: false, description: '검색 언어' },
      ],
      format: 'json',
      example: { keywords: 'AI trends', maxResults: 10, language: 'en' },
      description: '웹 검색 파라미터',
    },
    outputs: {
      fields: [
        {
          key: 'articles',
          type: 'array',
          required: true,
          arrayElementType: 'object',
          description: '검색 결과',
        },
        { key: 'totalResults', type: 'number', required: true, description: '총 결과 수' },
        { key: 'searchEngine', type: 'string', required: true, description: '검색 엔진' },
      ],
      format: 'json',
      example: {
        articles: [{ title: 'Title', url: 'url', summary: 'summary' }],
        totalResults: 1000,
        searchEngine: 'Google',
      },
      description: '웹 검색 결과',
    },
    transformDescription: '키워드를 검색 엔진으로 전송하고 결과를 기사 배열로 변환합니다.',
    validPredecessors: ['schedule', 'api-call', 'condition'],
    validSuccessors: ['ai-processing', 'data-transform', 'data-storage', 'notification'],
  },

  // 3. AI Processing - AI 처리
  'ai-processing': {
    nodeType: 'ai-processing',
    inputs: {
      fields: [
        { key: 'text', type: 'string', required: false, description: '처리 텍스트' },
        {
          key: 'articles',
          type: 'array',
          required: false,
          arrayElementType: 'object',
          description: '기사 배열',
        },
        { key: 'prompt', type: 'string', required: true, description: 'AI 프롬프트' },
        { key: 'model', type: 'string', required: false, description: 'LLM 모델' },
      ],
      format: 'json',
      example: {
        articles: [{ title: 'Title', content: 'content' }],
        prompt: 'Summarize',
        model: 'claude-3-opus',
      },
      description: 'AI 처리 입력',
    },
    outputs: {
      fields: [
        { key: 'summary', type: 'string', required: true, description: 'AI 요약' },
        { key: 'analysis', type: 'string', required: false, description: 'AI 분석' },
        { key: 'formatted_output', type: 'object', required: false, description: '구조화 출력' },
        { key: 'model_used', type: 'string', required: true, description: '사용 모델' },
        { key: 'tokens_used', type: 'object', required: true, description: '토큰 사용량' },
      ],
      format: 'json',
      example: {
        summary: '요약 결과',
        model_used: 'claude-3-opus',
        tokens_used: { input: 1000, output: 200 },
      },
      description: 'AI 처리 결과',
    },
    transformDescription: 'LLM을 통해 텍스트를 처리하고 요약, 분석, 구조화된 결과를 생성합니다.',
    validPredecessors: [
      'web-search',
      'data-transform',
      'api-call',
      'log-monitor',
      'file-operation',
    ],
    validSuccessors: [
      'email-send',
      'slack-message',
      'data-storage',
      'api-call',
      'condition',
      'notification',
    ],
  },

  // 4. Email Send - 이메일 전송
  'email-send': {
    nodeType: 'email-send',
    inputs: {
      fields: [
        { key: 'body_text', type: 'string', required: true, description: '이메일 본문' },
        { key: 'subject', type: 'string', required: true, description: '이메일 제목' },
        { key: 'recipient', type: 'string', required: true, description: '수신자' },
        { key: 'cc', type: 'string', required: false, description: 'CC' },
      ],
      format: 'json',
      example: { subject: '주간 요약', body_text: '내용', recipient: 'user@example.com' },
      description: '이메일 전송 입력',
    },
    outputs: {
      fields: [
        { key: 'messageId', type: 'string', required: true, description: '메시지 ID' },
        { key: 'sentAt', type: 'date', required: true, description: '전송 시간' },
        { key: 'deliveryStatus', type: 'string', required: true, description: '배송 상태' },
      ],
      format: 'json',
      example: { messageId: 'msg_123', sentAt: '2026-04-09T12:00:00Z', deliveryStatus: 'sent' },
      description: '이메일 전송 결과',
    },
    transformDescription: '데이터를 이메일 형식으로 변환하여 메일 서버로 전송합니다.',
    validPredecessors: ['ai-processing', 'data-transform', 'condition', 'notification'],
    validSuccessors: ['log-monitor', 'notification', 'wait-approval', 'condition'],
  },

  // 5. Slack Message - 슬랙 메시지
  'slack-message': {
    nodeType: 'slack-message',
    inputs: {
      fields: [
        { key: 'message_text', type: 'string', required: true, description: '메시지 텍스트' },
        { key: 'channel', type: 'string', required: true, description: '채널명' },
        {
          key: 'blocks',
          type: 'array',
          required: false,
          arrayElementType: 'object',
          description: '슬랙 블록',
        },
      ],
      format: 'json',
      example: { message_text: '알림', channel: '#alerts', blocks: [] },
      description: '슬랙 메시지 입력',
    },
    outputs: {
      fields: [
        { key: 'messageId', type: 'string', required: true, description: '메시지 ID' },
        { key: 'channel', type: 'string', required: true, description: '채널명' },
        { key: 'sentAt', type: 'date', required: true, description: '전송 시간' },
      ],
      format: 'json',
      example: {
        messageId: '1712662800.123456',
        channel: '#alerts',
        sentAt: '2026-04-09T12:00:00Z',
      },
      description: '슬랙 전송 결과',
    },
    transformDescription: '메시지를 슬랙 API 형식으로 변환하여 채널로 전송합니다.',
    validPredecessors: ['ai-processing', 'data-transform', 'condition', 'notification'],
    validSuccessors: ['log-monitor', 'notification', 'condition'],
  },

  // 6. Data Transform - 데이터 변환
  'data-transform': {
    nodeType: 'data-transform',
    inputs: {
      fields: [
        { key: 'raw_data', type: 'object', required: true, description: '원본 데이터' },
        { key: 'transformType', type: 'string', required: true, description: '변환 타입' },
        { key: 'mappingRules', type: 'object', required: false, description: '매핑 규칙' },
      ],
      format: 'json',
      example: { raw_data: { name: 'John' }, transformType: 'json-to-csv' },
      description: '데이터 변환 입력',
    },
    outputs: {
      fields: [
        { key: 'transformed_data', type: 'string', required: true, description: '변환된 데이터' },
        { key: 'transformType', type: 'string', required: true, description: '적용된 변환' },
        { key: 'sourceFormat', type: 'string', required: true, description: '원본 포맷' },
        { key: 'targetFormat', type: 'string', required: true, description: '대상 포맷' },
      ],
      format: 'text',
      example: {
        transformed_data: 'name\nJohn',
        transformType: 'json-to-csv',
        sourceFormat: 'json',
        targetFormat: 'csv',
      },
      description: '데이터 변환 결과',
    },
    transformDescription: '입력 데이터를 지정된 포맷으로 변환합니다.',
    validPredecessors: ['web-search', 'api-call', 'file-operation', 'log-monitor'],
    validSuccessors: ['data-storage', 'email-send', 'api-call', 'file-operation', 'notification'],
  },

  // 7. Data Storage - 데이터 저장
  'data-storage': {
    nodeType: 'data-storage',
    inputs: {
      fields: [
        { key: 'data', type: 'object', required: true, description: '저장 데이터' },
        { key: 'storageType', type: 'string', required: true, description: '저장소 타입' },
        { key: 'collectionName', type: 'string', required: true, description: '컬렉션명' },
      ],
      format: 'json',
      example: { data: { title: 'News' }, storageType: 'database', collectionName: 'articles' },
      description: '데이터 저장 입력',
    },
    outputs: {
      fields: [
        { key: 'recordId', type: 'string', required: true, description: '레코드 ID' },
        { key: 'storedAt', type: 'date', required: true, description: '저장 시간' },
        { key: 'collectionName', type: 'string', required: true, description: '컬렉션명' },
      ],
      format: 'json',
      example: {
        recordId: 'rec_123',
        storedAt: '2026-04-09T13:00:00Z',
        collectionName: 'articles',
      },
      description: '저장 결과',
    },
    transformDescription: '데이터를 지정된 저장소에 저장하고 메타데이터를 반환합니다.',
    validPredecessors: [
      'web-search',
      'ai-processing',
      'data-transform',
      'api-call',
      'file-operation',
    ],
    validSuccessors: ['notification', 'log-monitor', 'condition'],
  },

  // 8. Condition - 조건 분기
  condition: {
    nodeType: 'condition',
    inputs: {
      fields: [
        { key: 'value_to_check', type: 'object', required: true, description: '확인 값' },
        { key: 'condition', type: 'string', required: true, description: '조건식' },
        { key: 'threshold', type: 'number', required: false, description: '임계값' },
      ],
      format: 'json',
      example: { value_to_check: { score: 85 }, condition: 'score > 80' },
      description: '조건 평가 입력',
    },
    outputs: {
      fields: [
        { key: 'branch', type: 'string', required: true, description: '분기 결과' },
        { key: 'evaluatedCondition', type: 'string', required: true, description: '평가된 조건' },
        { key: 'value', type: 'object', required: true, description: '전달 값' },
      ],
      format: 'json',
      example: { branch: 'true', evaluatedCondition: 'score > 80', value: { score: 85 } },
      description: '조건 평가 결과',
    },
    transformDescription: '입력 값에 대해 조건을 평가하고 분기 결과를 반환합니다.',
    validPredecessors: ['ai-processing', 'data-storage', 'api-call', 'log-monitor'],
    validSuccessors: [
      'email-send',
      'slack-message',
      'api-call',
      'data-transform',
      'wait-approval',
      'condition',
    ],
  },

  // 9. API Call - API 호출
  'api-call': {
    nodeType: 'api-call',
    inputs: {
      fields: [
        { key: 'endpoint', type: 'string', required: true, description: 'API URL' },
        { key: 'method', type: 'string', required: true, description: 'HTTP 메서드' },
        { key: 'headers', type: 'object', required: false, description: 'HTTP 헤더' },
        { key: 'payload', type: 'object', required: false, description: 'Request body' },
      ],
      format: 'json',
      example: { endpoint: 'https://api.example.com', method: 'POST', headers: {}, payload: {} },
      description: 'API 호출 입력',
    },
    outputs: {
      fields: [
        { key: 'statusCode', type: 'number', required: true, description: '상태 코드' },
        { key: 'responseBody', type: 'object', required: true, description: '응답 본문' },
        { key: 'latencyMs', type: 'number', required: true, description: '응답 시간' },
      ],
      format: 'json',
      example: { statusCode: 200, responseBody: { result: 'success' }, latencyMs: 245 },
      description: 'API 응답',
    },
    transformDescription: '입력을 HTTP 요청으로 변환하여 API를 호출하고 응답을 반환합니다.',
    validPredecessors: ['schedule', 'condition', 'ai-processing', 'data-transform', 'webhook'],
    validSuccessors: [
      'web-search',
      'ai-processing',
      'data-transform',
      'data-storage',
      'condition',
      'notification',
    ],
  },

  // 10. Wait for Approval - 승인 대기
  'wait-approval': {
    nodeType: 'wait-approval',
    inputs: {
      fields: [
        { key: 'approvalRequest', type: 'string', required: true, description: '승인 요청' },
        { key: 'assignee', type: 'string', required: false, description: '승인자' },
        { key: 'timeout', type: 'number', required: false, description: '타임아웃' },
      ],
      format: 'json',
      example: { approvalRequest: '배포하시겠습니까?', assignee: 'manager@example.com' },
      description: '승인 요청 입력',
    },
    outputs: {
      fields: [
        { key: 'approved', type: 'boolean', required: true, description: '승인 여부' },
        { key: 'approvedBy', type: 'string', required: false, description: '승인자' },
        { key: 'approvedAt', type: 'date', required: false, description: '승인 시간' },
      ],
      format: 'json',
      example: {
        approved: true,
        approvedBy: 'manager@example.com',
        approvedAt: '2026-04-09T14:00:00Z',
      },
      description: '승인 결과',
    },
    transformDescription: '승인 요청을 발송하고 승인 응답을 대기한 후 결과를 반환합니다.',
    validPredecessors: ['email-send', 'slack-message', 'condition', 'api-call'],
    validSuccessors: ['condition', 'email-send', 'api-call', 'notification'],
  },

  // 11. Jira - Jira 이슈 관리
  jira: {
    nodeType: 'jira',
    inputs: {
      fields: [
        { key: 'action', type: 'string', required: true, description: 'Jira 액션' },
        { key: 'projectKey', type: 'string', required: true, description: '프로젝트 키' },
        { key: 'data', type: 'object', required: true, description: 'Jira 데이터' },
      ],
      format: 'json',
      example: {
        action: 'create',
        projectKey: 'PROJ',
        data: { summary: 'Bug report', issueType: 'Bug' },
      },
      description: 'Jira 작업 입력',
    },
    outputs: {
      fields: [
        { key: 'issueKey', type: 'string', required: true, description: '이슈 키' },
        { key: 'status', type: 'string', required: true, description: '이슈 상태' },
        { key: 'url', type: 'string', required: true, description: 'Jira URL' },
      ],
      format: 'json',
      example: {
        issueKey: 'PROJ-123',
        status: 'To Do',
        url: 'https://jira.example.com/browse/PROJ-123',
      },
      description: 'Jira 작업 결과',
    },
    transformDescription: '입력 데이터를 Jira REST API 호출로 변환하여 이슈를 관리합니다.',
    validPredecessors: ['condition', 'email-send', 'log-monitor', 'api-call'],
    validSuccessors: ['notification', 'condition', 'email-send'],
  },

  // 12. Git Deploy - Git 배포
  'git-deploy': {
    nodeType: 'git-deploy',
    inputs: {
      fields: [
        { key: 'repoUrl', type: 'string', required: true, description: 'Git URL' },
        { key: 'branch', type: 'string', required: true, description: '브랜치명' },
        { key: 'action', type: 'string', required: true, description: '배포 액션' },
        { key: 'environment', type: 'string', required: false, description: '환경' },
      ],
      format: 'json',
      example: {
        repoUrl: 'https://github.com/repo.git',
        branch: 'main',
        action: 'deploy',
        environment: 'prod',
      },
      description: 'Git 배포 입력',
    },
    outputs: {
      fields: [
        { key: 'commitHash', type: 'string', required: true, description: '커밋 해시' },
        { key: 'deployStatus', type: 'string', required: true, description: '배포 상태' },
        { key: 'deployedAt', type: 'date', required: true, description: '배포 시간' },
      ],
      format: 'json',
      example: {
        commitHash: 'abc123def',
        deployStatus: 'success',
        deployedAt: '2026-04-09T14:30:00Z',
      },
      description: '배포 결과',
    },
    transformDescription: '저장소에서 코드를 가져와 빌드하고 배포한 후 결과를 반환합니다.',
    validPredecessors: ['condition', 'wait-approval', 'jira', 'api-call', 'log-monitor'],
    validSuccessors: ['notification', 'log-monitor', 'condition', 'jira'],
  },

  // 13. Log Monitor - 로그 모니터링
  'log-monitor': {
    nodeType: 'log-monitor',
    inputs: {
      fields: [
        { key: 'logData', type: 'string', required: true, description: '로그 데이터' },
        { key: 'level', type: 'string', required: true, description: '로그 레벨' },
        { key: 'source', type: 'string', required: false, description: '로그 출처' },
      ],
      format: 'text',
      example: { logData: 'Connection timeout', level: 'ERROR', source: 'api-service' },
      description: '로그 입력',
    },
    outputs: {
      fields: [
        { key: 'logId', type: 'string', required: true, description: '로그 ID' },
        { key: 'alertTriggered', type: 'boolean', required: true, description: '알림 발동' },
        { key: 'processedAt', type: 'date', required: true, description: '처리 시간' },
      ],
      format: 'json',
      example: { logId: 'log_xyz', alertTriggered: true, processedAt: '2026-04-09T14:45:00Z' },
      description: '로그 처리 결과',
    },
    transformDescription: '로그를 분석하고 임계값과 비교하여 알림 발동 여부를 결정합니다.',
    validPredecessors: ['email-send', 'slack-message', 'api-call', 'git-deploy', 'jira'],
    validSuccessors: ['condition', 'notification', 'email-send', 'slack-message', 'jira'],
  },

  // 14. File Operation - 파일 작업
  'file-operation': {
    nodeType: 'file-operation',
    inputs: {
      fields: [
        { key: 'path', type: 'string', required: true, description: '파일 경로' },
        { key: 'operation', type: 'string', required: true, description: '작업 타입' },
        { key: 'content', type: 'string', required: false, description: '파일 내용' },
      ],
      format: 'text',
      example: { path: '/data/file.txt', operation: 'write', content: 'data' },
      description: '파일 작업 입력',
    },
    outputs: {
      fields: [
        { key: 'filePath', type: 'string', required: true, description: '파일 경로' },
        { key: 'success', type: 'boolean', required: true, description: '성공 여부' },
        { key: 'fileSize', type: 'number', required: false, description: '파일 크기' },
      ],
      format: 'text',
      example: { filePath: '/data/file.txt', success: true, fileSize: 1024 },
      description: '파일 작업 결과',
    },
    transformDescription: '파일을 읽거나 쓰거나 수정하고 작업 결과를 반환합니다.',
    validPredecessors: ['data-transform', 'ai-processing', 'api-call', 'log-monitor'],
    validSuccessors: [
      'data-transform',
      'ai-processing',
      'data-storage',
      'notification',
      'email-send',
    ],
  },

  // 15. Notification - 알림
  notification: {
    nodeType: 'notification',
    inputs: {
      fields: [
        { key: 'message', type: 'string', required: true, description: '알림 메시지' },
        { key: 'recipient', type: 'string', required: true, description: '수신자' },
        { key: 'channel', type: 'string', required: true, description: '채널' },
      ],
      format: 'json',
      example: { message: '작업 완료', recipient: 'user@example.com', channel: 'email' },
      description: '알림 입력',
    },
    outputs: {
      fields: [
        { key: 'notificationId', type: 'string', required: true, description: '알림 ID' },
        { key: 'delivered', type: 'boolean', required: true, description: '배달 여부' },
        { key: 'sentAt', type: 'date', required: true, description: '전송 시간' },
      ],
      format: 'json',
      example: { notificationId: 'notif_123', delivered: true, sentAt: '2026-04-09T15:15:00Z' },
      description: '알림 전송 결과',
    },
    transformDescription: '알림을 지정된 채널을 통해 수신자에게 전달합니다.',
    validPredecessors: [
      'data-storage',
      'condition',
      'email-send',
      'slack-message',
      'log-monitor',
      'wait-approval',
    ],
    validSuccessors: [],
  },

  // 16. Webhook - 웹훅
  webhook: {
    nodeType: 'webhook',
    inputs: {
      fields: [
        { key: 'method', type: 'string', required: true, description: 'HTTP 메서드' },
        { key: 'headers', type: 'object', required: false, description: 'HTTP 헤더' },
        { key: 'body', type: 'object', required: false, description: 'Request body' },
      ],
      format: 'json',
      example: { method: 'POST', headers: {}, body: { event: 'push' } },
      description: '웹훅 수신 입력',
    },
    outputs: {
      fields: [
        { key: 'statusCode', type: 'number', required: true, description: '상태 코드' },
        { key: 'responseBody', type: 'object', required: false, description: '응답' },
        { key: 'receivedAt', type: 'date', required: true, description: '수신 시간' },
      ],
      format: 'json',
      example: {
        statusCode: 200,
        responseBody: { status: 'ok' },
        receivedAt: '2026-04-09T15:30:00Z',
      },
      description: '웹훅 처리 결과',
    },
    transformDescription: '외부 시스템에서 수신한 웹훅 요청을 파싱하고 처리합니다.',
    validPredecessors: [],
    validSuccessors: ['web-search', 'ai-processing', 'api-call', 'data-transform', 'data-storage'],
  },
};

/**
 * UI 노드 타입 → 내부 계약 키 정규화 맵
 * Builder에서 생성되는 노드 타입명과 NODE_CONTRACTS 키 간의 매핑
 */
const NODE_TYPE_ALIASES: Record<string, string> = {
  // 검색 관련
  search: 'web-search',
  'web-search': 'web-search',
  websearch: 'web-search',
  // AI 관련
  ai: 'ai-processing',
  'ai-processing': 'ai-processing',
  llm: 'ai-processing',
  summarize: 'ai-processing',
  // 이메일 관련
  email: 'email-send',
  'email-send': 'email-send',
  mail: 'email-send',
  // 메시징 관련
  slack: 'slack-message',
  'slack-message': 'slack-message',
  messaging: 'slack-message',
  // 스케줄
  schedule: 'schedule',
  cron: 'schedule',
  timer: 'schedule',
  // 데이터
  transform: 'data-transform',
  'data-transform': 'data-transform',
  storage: 'data-storage',
  'data-storage': 'data-storage',
  database: 'data-storage',
  // API
  api: 'api-call',
  'api-call': 'api-call',
  webhook: 'webhook',
  // 조건/승인
  condition: 'condition',
  filter: 'condition',
  approval: 'wait-approval',
  'wait-approval': 'wait-approval',
  // 알림/로그
  notification: 'notification',
  notify: 'notification',
  log: 'log-monitor',
  'log-monitor': 'log-monitor',
  monitor: 'log-monitor',
  // 파일
  file: 'file-operation',
  'file-operation': 'file-operation',
  // 배포/이슈
  deploy: 'git-deploy',
  'git-deploy': 'git-deploy',
  jira: 'jira',
};

function normalizeNodeType(type: string): string {
  const lower = type.toLowerCase().trim();
  return NODE_TYPE_ALIASES[lower] || lower;
}

// 호환성 검사 함수
export function checkCompatibility(sourceType: string, targetType: string): CompatibilityResult {
  const normalizedSource = normalizeNodeType(sourceType);
  const normalizedTarget = normalizeNodeType(targetType);
  const source = NODE_CONTRACTS[normalizedSource];
  const target = NODE_CONTRACTS[normalizedTarget];

  if (!source || !target) {
    return {
      compatible: false,
      score: 0,
      mismatches: [
        {
          field: 'nodeType',
          expected: 'Valid type',
          actual: sourceType + ' or ' + targetType,
          severity: 'blocking',
        },
      ],
      adaptations: [],
      reasoning: '존재하지 않는 노드 타입입니다.',
    };
  }

  const structurallyCompatible = source.validSuccessors.includes(normalizedTarget);
  const mismatches: CompatibilityMismatch[] = [];
  const adaptations: CompatibilityAdaptation[] = [];

  const sourceOutputFields = source.outputs.fields;
  const targetInputFields = target.inputs.fields;

  for (const inputField of targetInputFields) {
    if (inputField.required) {
      const matchingOutput = sourceOutputFields.find((f) => f.key === inputField.key);
      if (!matchingOutput) {
        mismatches.push({
          field: inputField.key,
          expected: inputField.type,
          actual: 'not provided',
          severity: 'warning',
        });
      } else if (matchingOutput.type !== inputField.type) {
        const severity = getTypeSeverity(matchingOutput.type, inputField.type);
        mismatches.push({
          field: inputField.key,
          expected: inputField.type,
          actual: matchingOutput.type,
          severity,
        });
        if (canAutoAdapt(matchingOutput.type, inputField.type)) {
          adaptations.push({
            description: getAdaptationDescription(
              inputField.key,
              matchingOutput.type,
              inputField.type,
            ),
            autoApplicable: true,
          });
        }
      }
    }
  }

  const score = calculateCompatibilityScore(
    normalizedSource,
    normalizedTarget,
    structurallyCompatible,
    mismatches,
  );
  const compatible =
    structurallyCompatible && mismatches.filter((m) => m.severity === 'blocking').length === 0;
  const reasoning = generateReasoningText(
    normalizedSource,
    normalizedTarget,
    compatible,
    score,
    mismatches,
  );

  return { compatible, score, mismatches, adaptations, reasoning };
}

export function validatePipeline(nodeTypes: string[]): PipelineValidationResult {
  const pairs: Array<{ from: string; to: string; result: CompatibilityResult }> = [];
  let totalScore = 0;
  let validPairCount = 0;

  for (let i = 0; i < nodeTypes.length - 1; i++) {
    const result = checkCompatibility(nodeTypes[i], nodeTypes[i + 1]);
    pairs.push({ from: nodeTypes[i], to: nodeTypes[i + 1], result });
    totalScore += result.score;
    validPairCount++;
  }

  const overallScore = validPairCount > 0 ? Math.round(totalScore / validPairCount) : 100;
  const isExecutable = pairs.every((p) => p.result.compatible || p.result.score >= 60);
  const summary = generatePipelineSummary(nodeTypes, pairs, overallScore, isExecutable);

  return { overallScore, pairs, isExecutable, summary };
}

// Helper functions
function getTypeSeverity(
  actualType: FieldType,
  expectedType: FieldType,
): 'blocking' | 'warning' | 'adaptable' {
  const adaptablePairs: Array<[FieldType, FieldType]> = [
    ['string', 'json'],
    ['json', 'string'],
    ['object', 'json'],
    ['array', 'json'],
  ];
  if (adaptablePairs.some(([a, b]) => actualType === a && expectedType === b)) return 'adaptable';
  const incompatiblePairs: Array<[FieldType, FieldType]> = [
    ['date', 'number'],
    ['binary', 'string'],
  ];
  if (incompatiblePairs.some(([a, b]) => actualType === a && expectedType === b)) return 'blocking';
  return 'warning';
}

function canAutoAdapt(actualType: FieldType, expectedType: FieldType): boolean {
  const pairs: Array<[FieldType, FieldType]> = [
    ['string', 'json'],
    ['json', 'string'],
    ['object', 'json'],
    ['array', 'json'],
  ];
  return pairs.some(([a, b]) => actualType === a && expectedType === b);
}

function getAdaptationDescription(
  fieldKey: string,
  sourceType: FieldType,
  targetType: FieldType,
): string {
  if (sourceType === 'object' && targetType === 'json')
    return `${fieldKey} 필드를 JSON 문자열로 직렬화합니다.`;
  if (sourceType === 'array' && targetType === 'json')
    return `${fieldKey} 배열을 JSON 문자열로 직렬화합니다.`;
  if (sourceType === 'string' && targetType === 'json')
    return `${fieldKey} 문자열을 JSON 객체로 파싱합니다.`;
  if (sourceType === 'json' && targetType === 'string')
    return `${fieldKey} JSON을 문자열로 변환합니다.`;
  return `${fieldKey} 필드의 타입을 ${sourceType}에서 ${targetType}로 변환합니다.`;
}

function calculateCompatibilityScore(
  sourceType: string,
  targetType: string,
  structurallyCompatible: boolean,
  mismatches: CompatibilityMismatch[],
): number {
  let score = structurallyCompatible ? 40 : 10;
  const target = NODE_CONTRACTS[targetType];
  const totalFields = target.inputs.fields.length;
  if (totalFields > 0) {
    const matchedFields = totalFields - mismatches.length;
    score += (matchedFields / totalFields) * 40;
  } else {
    score += 40;
  }
  const blockingCount = mismatches.filter((m) => m.severity === 'blocking').length;
  if (blockingCount === 0)
    score += 20 - mismatches.filter((m) => m.severity === 'warning').length * 2;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function generateReasoningText(
  sourceType: string,
  targetType: string,
  compatible: boolean,
  score: number,
  mismatches: CompatibilityMismatch[],
): string {
  let text = '';
  if (score >= 80) text = `${sourceType}과 ${targetType}이 매우 잘 호환됩니다. `;
  else if (score >= 60)
    text = `${sourceType}과 ${targetType}이 어느 정도 호환되지만 적응이 필요합니다. `;
  else if (score >= 40) text = `${sourceType}과 ${targetType}이 제한적으로 호환됩니다. `;
  else text = `${sourceType}과 ${targetType}이 호환되지 않습니다. `;
  if (mismatches.length > 0) {
    const blocking = mismatches.filter((m) => m.severity === 'blocking');
    if (blocking.length > 0) text += `차단: ${blocking.map((m) => m.field).join(', ')}. `;
  }
  text += `호환성: ${score}/100.`;
  return text;
}

function generatePipelineSummary(
  nodeTypes: string[],
  pairs: Array<{ from: string; to: string; result: CompatibilityResult }>,
  overallScore: number,
  isExecutable: boolean,
): string {
  let summary = `파이프라인: ${nodeTypes.join(' → ')}. `;
  summary += isExecutable ? '실행 가능합니다. ' : '실행에 문제가 있을 수 있습니다. ';
  summary += `호환성: ${overallScore}/100.`;
  return summary;
}
