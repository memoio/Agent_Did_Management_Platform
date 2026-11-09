export type InjectedProvider = {
  request(args:{method:string;params?:unknown[]}):Promise<unknown>;
  on?(event:string,listener:(value:unknown)=>void):void;
  removeListener?(event:string,listener:(value:unknown)=>void):void;
  isMetaMask?:boolean;
  isRabby?:boolean;
  isOkxWallet?:boolean;
  isOKExWallet?:boolean;
  providers?:InjectedProvider[];
};

export type WalletName="MetaMask"|"OKX Wallet"|"Rabby";
export type WalletOption={name:WalletName;provider:InjectedProvider};
export type ProviderAnnouncement={info?:{name?:string;rdns?:string;uuid?:string};provider?:InjectedProvider};

function isProvider(value:unknown):value is InjectedProvider{
  return !!value&&typeof value==="object"&&typeof (value as InjectedProvider).request==="function";
}

function announcedName(info:ProviderAnnouncement["info"]):WalletName|undefined{
  const rdns=info?.rdns?.toLowerCase()||"",name=info?.name?.toLowerCase()||"";
  if(rdns==="io.rabby"||name.includes("rabby"))return "Rabby";
  if(["com.okex.wallet","com.okx.wallet"].includes(rdns)||/\bokx\b|\bokex\b/.test(name))return "OKX Wallet";
  if(rdns==="io.metamask"||name.includes("metamask"))return "MetaMask";
}

function legacyName(provider:InjectedProvider):WalletName|undefined{
  // Rabby and OKX may expose MetaMask compatibility flags.
  if(provider.isRabby)return "Rabby";
  if(provider.isOkxWallet||provider.isOKExWallet)return "OKX Wallet";
  if(provider.isMetaMask)return "MetaMask";
}

export function findInjectedWallets(
  announcements:ProviderAnnouncement[],
  legacy:{ethereum?:InjectedProvider;okxwallet?:InjectedProvider},
):WalletOption[]{
  const found:WalletOption[]=[],seen=new Set<InjectedProvider>(),seenNames=new Set<WalletName>();
  const add=(name:WalletName|undefined,provider:unknown)=>{
    if(!name||!isProvider(provider)||seen.has(provider)||seenNames.has(name))return;
    seen.add(provider);seenNames.add(name);found.push({name,provider});
  };
  for(const item of announcements)add(announcedName(item.info),item.provider);
  if(isProvider(legacy.okxwallet))add("OKX Wallet",legacy.okxwallet);
  const ethereum=legacy.ethereum;
  if(isProvider(ethereum)){
    for(const provider of Array.isArray(ethereum.providers)?ethereum.providers:[])add(isProvider(provider)?legacyName(provider):undefined,provider);
    add(legacyName(ethereum),ethereum);
  }
  const rank:Record<WalletName,number>={MetaMask:0,"OKX Wallet":1,Rabby:2};
  return found.sort((a,b)=>rank[a.name]-rank[b.name]);
}
