export function printHelp(): void {
  console.log("");
  console.log("Comandos disponiveis:");
  console.log("  openLogin");
  console.log("  login <username> <password>");
  console.log("  listConversations [limit]");
  console.log("  listConversationsIntercept [timeoutMs]");
  console.log("  debugInboxTraffic [timeoutMs]");
  console.log("  debugMessageTransport [timeoutMs]");
  console.log("  debugMessageTransportOnly [timeoutMs]");
  console.log("  debugInstagramSocket [timeoutMs]");
  console.log("  debugInstagramSocketDirect [timeoutMs]");
  console.log("  probeInstagramRealtime [timeoutMs]");
  console.log("  openConversation <conversationTitle>");
  console.log('  sendMessage <conversationTitle> | <text>');
  console.log("  listMessages <threadId> [limit]");
  console.log("  startMessageListener");
  console.log("  stopMessageListener");
  console.log("  startThreadListener <threadId>");
  console.log("  stopThreadListener");
  console.log("  startDmTap [debug]");
  console.log("  stopDmTap");
  console.log("  getDmTapStats");
  console.log("  resolveVoiceMessage <senderUsername> | <id numerico do audio>");
  console.log("  resolveImageMessage <senderUsername> | <id numerico da foto>");
  console.log("  mto:<senderUsername>");
  console.log("  closeBrowser");
  console.log("  help");
  console.log("  exit");
  console.log("");
}

export function printMessageModeHelp(targetUsername: string): void {
  console.log("");
  console.log(`Modo conversa com "${targetUsername}" ativo.`);
  console.log("Digite a mensagem e pressione Enter para enviar.");
  console.log("Comandos deste modo:");
  console.log("  /sair   - encerra o modo conversa");
  console.log("  /help   - mostra esta ajuda");
  console.log("  /audio     - link do ultimo audio desta conversa");
  console.log("  /audio <n> - link do audio com id simples (ex: /audio 2)");
  console.log("  /foto     - link da ultima foto desta conversa");
  console.log("  /foto <n> - link da foto com id simples (ex: /foto 2)");
  console.log("");
}
