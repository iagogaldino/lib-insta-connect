import "dotenv/config";
import { InstaConnect } from "./index";

async function main(): Promise<void> {
  const client = new InstaConnect();
  try {
    const currentUrl = await client.openLoginPage();
    console.log("Instagram login aberto em:", currentUrl);
    console.log("Pressione Ctrl + C para encerrar.");
  } catch (error) {
    console.error("Erro ao abrir login do Instagram:", error);
    await client.close();
  }
}

void main();
