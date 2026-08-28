import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { color } from './theme';
import { ProveedorSesion, useSesion } from './state/sesion';
import { Rutas } from './navigation/tipos';

import Bienvenida from './screens/Bienvenida';
import Inicio from './screens/Inicio';
import Escaner from './screens/Escaner';
import NoVerificado from './screens/NoVerificado';
import Aprobacion from './screens/Aprobacion';
import Firmado from './screens/Firmado';
import Dispositivo from './screens/Dispositivo';

const Stack = createNativeStackNavigator<Rutas>();

const tema = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: color.hueso, primary: color.intaglio },
};

function Rutero() {
  const { cargando, autenticado, identidad } = useSesion();

  if (cargando) {
    return (
      <View style={{ flex: 1, backgroundColor: color.tinta, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={color.hueso} />
      </View>
    );
  }

  const dentro = autenticado && identidad;

  return (
    <Stack.Navigator screenOptions={{ headerShown: false, animation: 'fade_from_bottom' }}>
      {!dentro ? (
        <Stack.Screen name="Bienvenida" component={Bienvenida} />
      ) : (
        <>
          <Stack.Screen name="Inicio" component={Inicio} />
          <Stack.Screen name="Escaner" component={Escaner} options={{ animation: 'slide_from_bottom' }} />
          <Stack.Screen name="NoVerificado" component={NoVerificado} />
          <Stack.Screen name="Aprobacion" component={Aprobacion} />
          <Stack.Screen name="Firmado" component={Firmado} />
          <Stack.Screen name="Dispositivo" component={Dispositivo} options={{ animation: 'slide_from_right' }} />
        </>
      )}
    </Stack.Navigator>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ProveedorSesion>
        <NavigationContainer theme={tema}>
          <Rutero />
        </NavigationContainer>
      </ProveedorSesion>
    </SafeAreaProvider>
  );
}
