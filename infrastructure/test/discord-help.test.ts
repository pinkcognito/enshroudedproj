import { commands } from '../lib/enshrouded/lambda/discord-bot/commands';

const mockSdkLoaded = jest.fn(() => { throw new Error('Help must not load AWS SDKs'); });
jest.mock('@aws-sdk/client-ssm', () => mockSdkLoaded(), { virtual: true });
jest.mock('@aws-sdk/client-ec2', () => mockSdkLoaded(), { virtual: true });
jest.mock('@aws-sdk/client-lambda', () => mockSdkLoaded(), { virtual: true });

type HelpResponse = { statusCode: number; headers: Record<string, string>; body: string };
const { helpResponse } = jest.requireActual('../lib/enshrouded/lambda/discord-bot/help') as {
  helpResponse: () => HelpResponse;
};

afterEach(() => jest.restoreAllMocks());

test('help is an immediate private interaction reply with no SDK or network work', () => {
  const fetch = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Help must not use the network'));
  const response = helpResponse();
  expect(response).not.toBeInstanceOf(Promise);
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toBe('application/json');
  const body = JSON.parse(response.body);
  expect(body).toMatchObject({ type: 4, data: { flags: 64 } });
  expect(body.data.content.length).toBeLessThanOrEqual(2000);
  expect(fetch).not.toHaveBeenCalled();
  expect(mockSdkLoaded).not.toHaveBeenCalled();
});

test('help documents every registered subcommand without advertising unimplemented commands', () => {
  const content = JSON.parse(helpResponse().body).data.content as string;
  const documented = [...content.matchAll(/`\/enshrouded (\w+)`/g)].map((match) => match[1]).sort();
  const registered = commands.find((command) => command.name === 'enshrouded')?.options?.map((option) => option.name).sort();
  expect(documented).toEqual(registered);
});

