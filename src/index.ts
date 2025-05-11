
import OpenAI from "openai";
import { createSchema, createYoga } from "graphql-yoga";

export interface Env {
	DEEPSEEK_API_KEY: string;
	[key: string]: any;
}

const yoga = createYoga<Env>({
	schema: createSchema({
		typeDefs: /* GraphQL */ `
    type Query {
        hello: String!
        deepseekChat(prompt: String!, model: String, systemPrompt: String): DeepseekResponse!
    }
	type Mutation {
      # 返回一个唯一标识符，可用于建立 SSE 连接
      deepseekChatStream(prompt: String!, model: String, systemPrompt: String): String!
    }
    
    type DeepseekResponse {
        id: String
        object: String
        created: Int
        model: String
        choices: [DeepseekChoice!]
        usage: DeepseekUsage
    }

    type DeepseekChoice {
        index: Int
        message: DeepseekMessage
        finish_reason: String
    }

    type DeepseekMessage {
        role: String
        content: String
    }

    type DeepseekUsage {
        prompt_tokens: Int
        completion_tokens: Int
        total_tokens: Int
    }
    `,
		resolvers: {
			Query: {
				hello: () => "Hello world!",
				deepseekChat: async (_, { prompt, model = "deepseek-chat", systemPrompt = "" }, context) => {
					try {
						const requestBody = {
							model: model,
							messages: [
								...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
								{ role: "user", content: prompt }
							],
							temperature: 0.7,
							max_tokens: 1000,
							stream: false
						};
				
						console.log('Request body:', JSON.stringify(requestBody, null, 2));
				
						const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								"Authorization": `Bearer ${context.DEEPSEEK_API_KEY}`
							},
							body: JSON.stringify(requestBody)
						});
				
						if (!response.ok) {
							const errorData:any = await response.json();
							if (errorData.error?.message === 'Insufficient Balance') {
							  throw new Error('API 余额不足，请检查账户或联系管理员');
							}
							throw new Error(`DeepSeek API 错误: ${JSON.stringify(errorData)}`);
						  }
						  return await response.json();
				
						const result = await response.json();
						console.log('DeepSeek API response:', result);
						return result;
					} catch (error: any) {
						throw new Error(`请求失败: ${error.message}`);
					}
				}
			},
			Mutation: {
				deepseekChatStream: async (_, { prompt, model = "deepseek-chat", systemPrompt = "" }, context) => {
					// 生成一个唯一ID，用于标识此次请求
					const requestId = crypto.randomUUID();

					// 在实际应用中，你可能会将请求详情存储在 Cloudflare KV 或 Durable Objects 中
					// 这里我们暂时将其存储在 context 中作为示例
					// 注意：这种方式在生产环境中不可靠，因为 Worker 是无状态的

					// 将请求信息保存，以便后续 SSE 处理程序使用
					if (!context.streamRequests) {
						context.streamRequests = new Map();
					}

					context.streamRequests.set(requestId, {
						prompt,
						model,
						systemPrompt,
						timestamp: Date.now()
					});

					// 返回请求ID给客户端
					return requestId;
				}
			}
		}
	}),
	graphqlEndpoint: "/",
	landingPage: true,
	cors: true,
});


const sharedContext = {
	streamRequests: new Map()
};


export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith('/stream/')) {
			return handleSSE(request, env, ctx, sharedContext);
		}
		return yoga.fetch(request, env);
	},
};

// 处理 SSE 连接
async function handleSSE(request: Request, env: Env, ctx: ExecutionContext, sharedContext: any): Promise<Response> {
	const url = new URL(request.url);
	const requestId = url.pathname.replace('/stream/', '');
	
	// 检查请求ID是否存在
	if (!sharedContext.streamRequests || !sharedContext.streamRequests.has(requestId)) {
	  return new Response('Invalid stream ID', { status: 404 });
	}
	
	// 获取请求详情
	const { prompt, model, systemPrompt } = sharedContext.streamRequests.get(requestId);
	
	// 设置 SSE 响应头
	const headers = new Headers({
	  'Content-Type': 'text/event-stream',
	  'Cache-Control': 'no-cache',
	  'Connection': 'keep-alive'
	});
	
	// 创建并返回 ReadableStream
	const stream = new ReadableStream({
	  async start(controller) {
		try {
		  // 发送开始事件
		  controller.enqueue(encodeSSE({ type: 'start' }));
		  
		  // 构建请求体
		  const requestBody = {
			model: model,
			messages: [
			  ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
			  { role: "user", content: prompt }
			],
			temperature: 0.7,
			max_tokens: 1000,
			stream: true // 启用流式响应
		  };
  
		  // 发送请求到DeepSeek API
		  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
			method: 'POST',
			headers: {
			  'Content-Type': 'application/json',
			  'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`
			},
			body: JSON.stringify(requestBody)
		  });
  
		  if (!response.ok) {
			const errorData = await response.json();
			throw new Error(`DeepSeek API error: ${response.status} ${JSON.stringify(errorData)}`);
		  }
  
		  // 处理 DeepSeek 流式响应
		  const reader = response.body?.getReader();
		  
		  if (reader) {
			const decoder = new TextDecoder();
			
			while (true) {
			  const { done, value } = await reader.read();
			  if (done) break;
			  
			  const chunk = decoder.decode(value, { stream: true });
			  
			  // 解析 SSE 格式的数据
			  const lines = chunk.split('\n');
			  for (const line of lines) {
				if (line.startsWith('data: ') && line !== 'data: [DONE]') {
				  try {
					const data = JSON.parse(line.substring(6));
					// 发送解析后的数据
					controller.enqueue(encodeSSE({ type: 'chunk', data }));
				  } catch (e) {
					console.error('Error parsing SSE data:', e);
				  }
				} else if (line === 'data: [DONE]') {
				  // 处理完成事件
				  controller.enqueue(encodeSSE({ type: 'done' }));
				}
			  }
			}
		  }
		  
		  // 清理请求信息
		  sharedContext.streamRequests.delete(requestId);
		  
		  // 结束流
		  controller.close();
		} catch (error:any) {
		  console.error('Error in stream processing:', error);
		  // 发送错误事件
		  controller.enqueue(encodeSSE({ type: 'error', error: error.message }));
		  controller.close();
		}
	  }
	});
  
	return new Response(stream, { headers });
  }
  
  // 编码 SSE 消息
  function encodeSSE(data: any): string {
	return `data: ${JSON.stringify(data)}\n\n`;
  }
  
