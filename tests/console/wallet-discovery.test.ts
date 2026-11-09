import {describe,expect,it} from "vitest";
import {findInjectedWallets,type InjectedProvider} from "../../apps/console/src/wallet-discovery.js";

const provider=(flags:Partial<InjectedProvider>={}):InjectedProvider=>({request:async()=>[],...flags});

describe("supported wallet discovery",()=>{
  it("finds MetaMask, OKX and Rabby from EIP-6963 without duplicate legacy entries",()=>{
    const meta=provider({isMetaMask:true}),okx=provider(),rabby=provider({isRabby:true,isMetaMask:true});
    const found=findInjectedWallets([
      {info:{name:"Rabby Wallet",rdns:"io.rabby",uuid:"r"},provider:rabby},
      {info:{name:"MetaMask",rdns:"io.metamask",uuid:"m"},provider:meta},
      {info:{name:"OKX Wallet",rdns:"com.okx.wallet",uuid:"o"},provider:okx},
      {info:{name:"MetaMask",rdns:"io.metamask",uuid:"m"},provider:meta},
    ],{ethereum:meta,okxwallet:okx});
    expect(found.map(x=>x.name)).toEqual(["MetaMask","OKX Wallet","Rabby"]);
    expect(found.map(x=>x.provider)).toEqual([meta,okx,rabby]);
  });

  it("uses legacy providers when announcements are unavailable and prefers Rabby flags",()=>{
    const rabby=provider({isRabby:true,isMetaMask:true}),okx=provider({isOKExWallet:true});
    const ethereum=provider({providers:[rabby,okx]});
    expect(findInjectedWallets([],{ethereum}).map(x=>x.name)).toEqual(["OKX Wallet","Rabby"]);
  });

  it("does not silently use an unrelated default wallet",()=>{
    const unknown=provider(),meta=provider({isMetaMask:true});
    expect(findInjectedWallets([{info:{name:"Unknown Wallet",rdns:"org.example.wallet"},provider:unknown}],{ethereum:unknown})).toEqual([]);
    expect(findInjectedWallets([],{ethereum:meta})).toEqual([{name:"MetaMask",provider:meta}]);
  });
});
