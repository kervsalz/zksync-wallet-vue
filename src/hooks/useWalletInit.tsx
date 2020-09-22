import { useCallback, useState } from 'react';
import { ethers, Wallet, getDefaultProvider } from 'ethers';
import crypto from 'crypto';
import { EthSignerType } from 'zksync/build/types';

import { useCancelable } from 'hooks/useCancelable';
import {
  portisConnector,
  fortmaticConnector,
  walletConnectConnector,
  burnerWalletConnector,
} from 'components/Wallets/walletConnectors';

import { IEthBalance } from 'types/Common';

import { LINKS_CONFIG } from 'src/config';

import { DEFAULT_ERROR } from 'constants/errors';
import { WSTransport } from 'zksync/build/transport';
import { fetchTransactions } from 'src/api';
import { useLogout } from './useLogout';
import { loadTokens, sortBalancesById } from 'src/utils';
import { useStore } from 'src/store/context';
import { handleFormatToken, checkForEmptyBalance } from 'src/utils';

const useWalletInit = () => {
  const store = useStore();
  const cancelable = useCancelable();

  const connect = useCallback(
    (provider, signUp, prevProviderState?) => {
      store.zkWalletInitializing = true;
      const wCQRScanned = localStorage.getItem('walletconnect');
      if (provider && !store.isMetamaskWallet) {
        signUp()
          .then(async res => {
            store.ethId = res;

            if (!wCQRScanned && store.isWalletConnect) {
              store.zkWalletInitializing = false;
            }
            if (store.isPortisWallet) {
              store.zkWalletInitializing = false;
              store.hint = 'Connected to ';
            }
            if (store.isFortmaticWallet) {
              if (store.hint === 'Connected to ') {
                store.zkWalletInitializing = true;
              }
              if (!!store.provider && store.hint !== 'Connected to ') {
                store.zkWalletInitializing = false;
                store.hint = 'Connected to ';
              }
            }
            if (store.isWalletConnect || store.isPortisWallet) {
              store.hint = 'Connected to ';
              if (!store.isWalletConnect) {
                store.zkWalletInitializing = false;
              }
            }
            if (store.isWalletConnect && !!prevProviderState) {
              store.hint = 'Connecting to ';
            }
            store.isAccessModalOpen = true;
          })
          .catch(err => {
            if (err.name && err.message) {
              store.error = `${err.name}: ${err.message}`;
            }
            store.walletName = '';
            store.zkWallet = null;
            store.provider = null;
            store.isAccessModalOpen = false;
          });
      } else if (store.isMetamaskWallet) {
        if (!prevProviderState) {
          store.hint = 'Connected to ';
        } else {
          store.hint = 'Connecting to ';
        }
        store.isAccessModalOpen = true;
      } else {
        store.isAccessModalOpen = false;
        store.hint = 'Please install it \n https://metamask.io/';
        store.error = `${store.walletName} not detected`;
      }
    },
    [store],
  );

  const getSigner = useCallback(
    provider => {
      if (provider && !store.isBurnerWallet && !store.isExternalWallet) {
        const signer = new ethers.providers.Web3Provider(provider).getSigner();
        return signer;
      }
    },
    [store.isBurnerWallet, store.isExternalWallet],
  );

  const logout = useLogout();

  const createWallet = useCallback(async () => {
    try {
      const zkSync = await import('zksync');
      store.zkWalletInitializing = true;
      if (!store.provider && (store.isMetamaskWallet || store.isWeb3)) {
        store.provider = store.windowEthereumProvider;
      } else if (store.isPortisWallet && !store.isPrimaryPage) {
        await portisConnector(store, connect, getSigner);
      } else if (store.isFortmaticWallet) {
        fortmaticConnector(store, connect, getSigner);
        store.zkWalletInitializing = true;
      } else if (store.isWalletConnect) {
        walletConnectConnector(store, connect);
      } else if (store.isBurnerWallet || store.isExternalWallet) {
        burnerWalletConnector(store);
      }
      const provider = store.provider;
      if (
        provider &&
        !provider.selectedAddress &&
        (store.isMetamaskWallet || store.isWeb3)
      ) {
        // Could fail, if there's no Metamask in the browser
        if (store.isMetamaskWallet && store.doesMetamaskUsesNewEthereumAPI) {
          const _accs = await store.windowEthereumProvider?.request({
            method: 'eth_accounts',
          });
          if (!_accs[0]) {
            await store.provider.request({ method: 'eth_requestAccounts' });
          }
        } else {
          store.windowEthereumProvider?.enable();
        }
        store.hint = 'Connected to ';
      }

      if (
        provider &&
        !provider.selectedAddress &&
        !store.isBurnerWallet &&
        !store.isFortmaticWallet
      ) {
        store.hint = 'Connected to ';
      }

      if (store.isBurnerWallet) {
        const burnerWallet = window.localStorage?.getItem('burnerWallet');
        const provider = await getDefaultProvider(LINKS_CONFIG.network);
        if (!!burnerWallet) {
          const walletWithProvider = new Wallet(
            JSON.parse(burnerWallet),
            provider,
          );
          store.ethWallet = walletWithProvider as ethers.Signer;
        } else {
          const randomWallet = await Wallet.createRandom();
          const walletWithProvider = await randomWallet.connect(provider);
          store.ethWallet = walletWithProvider as ethers.Signer;
          window.localStorage?.setItem(
            'burnerWallet',
            JSON.stringify(randomWallet.privateKey),
          );
        }
      }
      const wallet = getSigner(provider);

      if (
        !store.isBurnerWallet &&
        !store.isCoinbaseWallet &&
        !store.isExternalWallet
      ) {
        store.ethWallet = wallet;
      }

      const externalWalletInstance = {
        provider: await getDefaultProvider(LINKS_CONFIG.network),
        address: store.externalWalletAddress,
        getAddress: async () => {
          return externalWalletInstance.address;
        },
      };

      const network =
        process.env.ETH_NETWORK === 'localhost' ? 'localhost' : 'testnet';
      const syncProvider = await zkSync.Provider.newWebsocketProvider(
        LINKS_CONFIG.ws_api,
      );

      const burnerWalletBased =
        store.isBurnerWallet || store.isExternalWallet
          ? store.ethWallet
          : wallet;

      const externalWalletBased = store.isExternalWallet
        ? externalWalletInstance
        : burnerWalletBased;

      const generatedRandomSeed = crypto.randomBytes(32);

      const walletBasedSigner = store.isExternalWallet
        ? zkSync.Signer.fromSeed(generatedRandomSeed)
        : undefined;

      const syncWalletArgs = {
        ethWallet: externalWalletBased as ethers.providers.JsonRpcSigner,
        provider: syncProvider,
        signer: walletBasedSigner,
      };

      const verificationMethod: EthSignerType = {
        verificationMethod: 'ECDSA',
        isSignedMsgPrefixed: true,
      };

      store.externalWalletEthersSigner = walletBasedSigner;

      const syncWallet = await zkSync.Wallet.fromEthSigner(
        syncWalletArgs.ethWallet,
        syncWalletArgs.provider,
        syncWalletArgs.signer,
        undefined,
        verificationMethod,
      );

      const transport = syncProvider.transport as WSTransport;
      const accountState = await syncWallet.getAccountState();
      store.verified = accountState?.verified.balances;
      const maxConfirmAmount = await syncProvider.getConfirmationsForEthOpAmount();

      if (store.isAccessModalOpen || store.isExternalWallet) {
        store.setBatch({
          syncProvider: syncProvider,
          syncWallet: syncWallet,
          wsTransport: transport,
          zkWallet: syncWallet,
          accountState,
        });
      }

      fetch('https://stage-api.zksync.dev/api/v0.1/withdrawal_processing_time')
        .then(res => res.json())
        .then(data => {
          store.withdrawalProcessingTime = data.normal;
          store.fastWithdrawalProcessingTime = data.fast;
        });

      const arr = window.localStorage?.getItem(
        `contacts${store.syncWallet?.address()}`,
      );
      if (arr) {
        store.searchContacts = JSON.parse(arr);
      }

      await fetchTransactions(25, 0, syncWallet.address())
        .then(res => (store.transactions = res))
        .catch(err => console.error(err));

      const { error, tokens, zkBalances } = await loadTokens(
        syncProvider,
        syncWallet,
        accountState,
      );
      if (error) {
        store.error = error;
      }
      store.setBatch({
        tokens: tokens,
        searchBalances: zkBalances,
        zkBalances: zkBalances,
        zkBalancesLoaded: true,
        maxConfirmAmount,
      });
      store.modalSpecifier = '';
      store.modalHintMessage = '';
      if (store.isExternalWallet) return;

      const prices = {};
      store.ethBalances.map(async balance => {
        //TODO: replace with Promise.All
        const price = store.syncProvider?.getTokenPrice(balance.symbol);
        prices[balance.symbol] = await price;
        store.price = prices;
      });

      await syncWallet
        .getAccountState()
        .then(res => res)
        .then(() => {
          cancelable(store.zkWallet?.isSigningKeySet()).then(data => {
            store.unlocked = data;
          });
        });
      if (accountState?.id) {
        await cancelable(store.zkWallet?.isSigningKeySet()).then(data => {
          store.unlocked = data;
        });
      }
      store.zkWalletInitializing = false;
    } catch (err) {
      store.zkWalletInitializing = false;
      const error = err.message
        ? !!err.message.match(/(?:denied)/i)
        : !!err.match(/(?:denied)/i);
      if (error) {
        logout(false, '');
      }
      store.walletName = '';
      console.error('CreateWallet error', err);
    }
  }, [cancelable, connect, getSigner, logout, store]);

  return {
    connect,
    createWallet,
    getSigner,
  };
};

export default useWalletInit;
